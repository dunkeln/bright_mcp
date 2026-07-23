import { benchmarkProfile, workflowCases } from "./workflows";
import { writeReport, type ServerId } from "./mcp";

const dimensions = ["taskFulfillment", "evidenceGrounding", "informationDensity", "sourceQuality", "actionability"] as const;
const scoreMinimum = 0;
const scoreMaximum = 10;
const scoreValues = Array.from({ length: scoreMaximum + 1 }, (_, value) => value);
const judgeBatchSize = 5;
const rubric = `You are a blind evaluator comparing two MCP-assisted answers to the same task. Judge the final response against the supplied tool evidence. Do not score tool selection or call count; deterministic MCP checks cover those. Do not reward verbosity, brand, or a preferred tool sequence. Do not use outside knowledge to repair an answer.

Score A and B independently with integers from 0 to 10. Use the full anchored scale: 0 means absent or unusable, 5 means adequate with material limitations, and 10 means complete with no material defect.
- taskFulfillment: satisfies the requested task and format.
- evidenceGrounding: claims are supported by the supplied tool evidence.
- informationDensity: useful information per word/token, balancing richness and compactness.
- sourceQuality: sources are relevant, credible, sufficiently diverse, and current when required.
- actionability: the result is immediately usable and makes limitations clear.

Choose the stronger artifact overall, or tie when materially equivalent. Confidence must also be an integer from 0 to 10. Give one concise evidence-based reason naming the most important observable difference. Return one judgment for every pairId.`;

const apiKey = required("OPENROUTER_API_KEY");
const judgeModel = required("OPENROUTER_JUDGE");
const artifact = (await Bun.file(new URL("../.artifacts/agent.json", import.meta.url)).json()) as AgentReport;
const judgeArtifact = Bun.file(new URL("../.artifacts/judge.json", import.meta.url));
if (artifact.schemaVersion !== 7 || artifact.profile !== benchmarkProfile || !Number.isInteger(artifact.turnsPerCase)) throw new Error("Run the agent evaluation before judging it.");

const expected = workflowCases.length * artifact.runsPerCase * 2;
if (artifact.results.length !== expected) throw new Error(`Agent evaluation is incomplete (${artifact.results.length}/${expected}).`);
const emptyResults = artifact.results.filter(({ response }) => !response.trim()).length;
if (emptyResults) throw new Error(`Agent evaluation contains ${emptyResults} empty responses; resume the agent evaluation before judging it.`);

const pairs = workflowCases.flatMap((useCase) =>
  Array.from({ length: artifact.runsPerCase }, (_, index) => {
    const run = index + 1;
    const bright = artifact.results.find((result) => result.caseId === useCase.id && result.server === "bright" && result.run === run);
    const upstream = artifact.results.find((result) => result.caseId === useCase.id && result.server === "upstream" && result.run === run);
    if (!bright || !upstream) throw new Error(`Missing pair ${useCase.id}:${run}.`);
    return { id: `${useCase.id}:${run}`, prompt: useCase.turns.slice(0, artifact.turnsPerCase).map((prompt, turn) => `Turn ${turn + 1}: ${prompt}`).join("\n"), bright, upstream };
  }),
);

const previous = await readPrevious();
if (previous.judgments.length === pairs.length && typeof previous.sideAgreement === "number") {
  console.log("Paired judgments are already complete.");
  process.exit(0);
}
const judgments = previous.judgments;
const remaining = pairs.filter((pair) => !judgments.some(({ pairId }) => pairId === pair.id));
for (let index = 0; index < remaining.length; index += judgeBatchSize) {
  judgments.push(...await judge(remaining.slice(index, index + judgeBatchSize).map((pair) => blind(pair, false))));
  await persist();
  console.log(`${judgments.length}/${pairs.length} paired judgments`);
}

const swapped = workflowCases.map((useCase) => blind(pairs.find((pair) => pair.id === `${useCase.id}:1`)!, true));
const consistency: Judgment[] = [];
for (let index = 0; index < swapped.length; index += judgeBatchSize) consistency.push(...await judge(swapped.slice(index, index + judgeBatchSize)));
const originals = new Map(judgments.map((item) => [item.pairId, item]));
const sideAgreement = consistency.filter((item) => item.winner === originals.get(item.pairId)?.winner).length / consistency.length;
await persist(sideAgreement);

type Scores = Record<(typeof dimensions)[number], number>;
type AgentResult = { caseId: string; server: ServerId; run: number; response: string; toolCalls: unknown[]; toolEvidence: unknown[] };
type AgentReport = { schemaVersion: number; profile: string; generatedAt: string; model: string; runsPerCase: number; turnsPerCase: number; results: AgentResult[] };
type Pair = { id: string; prompt: string; bright: AgentResult; upstream: AgentResult };
type BlindPair = { pairId: string; prompt: string; aServer: ServerId; bServer: ServerId; artifactA: string; artifactB: string };
type Judgment = { pairId: string; scores: Record<ServerId, Scores>; winner: ServerId | "tie"; confidence: number; reason: string };
type Previous = { judgments: Judgment[]; sideAgreement?: number };

function blind(pair: Pair, swap: boolean): BlindPair {
  const brightFirst = (hash(pair.id) % 2 === 0) !== swap;
  const a = brightFirst ? pair.bright : pair.upstream;
  const b = brightFirst ? pair.upstream : pair.bright;
  return { pairId: pair.id, prompt: pair.prompt, aServer: a.server, bServer: b.server, artifactA: compact(a), artifactB: compact(b) };
}

async function judge(pairs: BlindPair[]): Promise<Judgment[]> {
  const body = {
    model: judgeModel,
    messages: [
      { role: "system", content: rubric },
      { role: "user", content: JSON.stringify(pairs.map(({ aServer: _a, bServer: _b, ...pair }) => pair)) },
    ],
    response_format: { type: "json_schema", json_schema: { name: "paired_mcp_judgments", strict: true, schema: responseSchema(pairs.map(({ pairId }) => pairId)) } },
    provider: { require_parameters: true },
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`Judge returned HTTP ${response.status}: ${await response.text()}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const parsed = validate(JSON.parse(payload.choices?.[0]?.message?.content ?? "null"), pairs);
      return parsed.map((item) => {
        const pair = pairs.find(({ pairId }) => pairId === item.pairId)!;
        return {
          pairId: item.pairId,
          scores: { [pair.aServer]: item.scores.A, [pair.bServer]: item.scores.B } as Record<ServerId, Scores>,
          winner: item.winner === "tie" ? "tie" : item.winner === "A" ? pair.aServer : pair.bServer,
          confidence: item.confidence,
          reason: item.reason,
        };
      });
    } catch (error) {
      lastError = error;
      if (attempt < 2) await Bun.sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

function compact(result: AgentResult) {
  return limit(JSON.stringify({ response: result.response, toolCalls: result.toolCalls, toolEvidence: result.toolEvidence }), 16_000);
}

function validate(value: unknown, pairs: BlindPair[]) {
  if (!value || typeof value !== "object" || !("judgments" in value) || !Array.isArray(value.judgments)) throw new Error("Judge returned invalid JSON.");
  if (value.judgments.length !== pairs.length) throw new Error("Judge returned the wrong number of judgments.");
  const returnedIds = value.judgments.map((item) => item && typeof item === "object" && "pairId" in item ? String(item.pairId) : "");
  if (new Set(returnedIds).size !== pairs.length || pairs.some(({ pairId }) => !returnedIds.includes(pairId))) throw new Error("Judge returned duplicate or missing pairs.");
  return value.judgments.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Judge returned an invalid judgment.");
    const candidate = item as { pairId?: unknown; scores?: unknown; winner?: unknown; confidence?: unknown; reason?: unknown };
    const pairId = String(candidate.pairId ?? "");
    if (!pairs.some((pair) => pair.pairId === pairId)) throw new Error(`Judge returned unknown pair ${pairId}.`);
    const scores = candidate.scores as Record<string, unknown> | undefined;
    const parsedScores = { A: score(scores?.A), B: score(scores?.B) };
    if (!(["A", "B", "tie"] as unknown[]).includes(candidate.winner)) throw new Error("Judge returned an invalid winner.");
    if (!Number.isInteger(candidate.confidence) || Number(candidate.confidence) < scoreMinimum || Number(candidate.confidence) > scoreMaximum) throw new Error("Judge returned invalid confidence.");
    if (typeof candidate.reason !== "string" || !candidate.reason.trim()) throw new Error("Judge returned no rationale.");
    return { pairId, scores: parsedScores, winner: candidate.winner as "A" | "B" | "tie", confidence: Number(candidate.confidence), reason: candidate.reason.trim() };
  });
}

function score(value: unknown): Scores {
  if (!value || typeof value !== "object") throw new Error("Judge returned invalid scores.");
  return Object.fromEntries(dimensions.map((dimension) => {
    const value_ = (value as Record<string, unknown>)[dimension];
    if (!Number.isInteger(value_) || Number(value_) < scoreMinimum || Number(value_) > scoreMaximum) throw new Error(`Judge returned invalid ${dimension}.`);
    return [dimension, Number(value_)];
  })) as Scores;
}

function responseSchema(pairIds: string[]) {
  const scoreProperties = Object.fromEntries(dimensions.map((dimension) => [dimension, { type: "integer", enum: scoreValues }]));
  const scores = { type: "object", additionalProperties: false, required: [...dimensions], properties: scoreProperties };
  return {
    type: "object", additionalProperties: false, required: ["judgments"], properties: {
      judgments: { type: "array", items: {
        type: "object", additionalProperties: false, required: ["pairId", "scores", "winner", "confidence", "reason"], properties: {
          pairId: { type: "string", enum: pairIds },
          scores: { type: "object", additionalProperties: false, required: ["A", "B"], properties: { A: scores, B: scores } },
          winner: { type: "string", enum: ["A", "B", "tie"] },
          confidence: { type: "integer", enum: scoreValues },
          reason: { type: "string" },
        },
      } },
    },
  };
}

function hash(value: string) { return [...value].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 0); }
function limit(value: string, maximum: number) { return value.length <= maximum ? value : `${value.slice(0, maximum / 2)}\n…[truncated]…\n${value.slice(-maximum / 2)}`; }
function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required.`); return value; }

async function readPrevious(): Promise<Previous> {
  if (!(await judgeArtifact.exists())) return { judgments: [] };
  const value = await judgeArtifact.json() as { schemaVersion?: number; model?: string; agentModel?: string; agentGeneratedAt?: string; runsPerCase?: number; turnsPerCase?: number; judgments?: Judgment[]; sideAgreement?: number };
  return value.schemaVersion === 3 && value.model === judgeModel && value.agentModel === artifact.model && value.agentGeneratedAt === artifact.generatedAt && value.runsPerCase === artifact.runsPerCase && value.turnsPerCase === artifact.turnsPerCase && Array.isArray(value.judgments)
    ? { judgments: value.judgments, sideAgreement: value.sideAgreement }
    : { judgments: [] };
}

async function persist(sideAgreement?: number) {
  await writeReport("judge", {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    model: judgeModel,
    agentModel: artifact.model,
    agentGeneratedAt: artifact.generatedAt,
    runsPerCase: artifact.runsPerCase,
    turnsPerCase: artifact.turnsPerCase,
    scale: { minimum: scoreMinimum, maximum: scoreMaximum },
    rubric: dimensions,
    ...(sideAgreement === undefined ? {} : { sideAgreement }),
    judgments,
  });
}
