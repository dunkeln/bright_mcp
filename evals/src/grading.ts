type OutcomeCase = {
  requiredKeys: readonly string[];
  minimumUrls?: number;
};

export function validatesOutcome(text: string, useCase: OutcomeCase) {
  const value = parseJsonResponse(text);
  if (value === undefined) return false;
  const records = Array.isArray(value) ? value : [value];
  const fieldsPresent = records.length > 0 && records.every((record) =>
    record !== null && typeof record === "object" &&
    useCase.requiredKeys.every((key) => key in record)
  );
  const minimumUrls = useCase.minimumUrls ?? 0;
  const urls = new Set(JSON.stringify(value).match(/https?:\\?\/\\?\/[^\s"'<>]+/g) ?? []);
  return fieldsPresent && urls.size >= minimumUrls;
}

function parseJsonResponse(text: string) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const blocks = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
    if (blocks.length !== 1) return undefined;
    try {
      return JSON.parse(blocks[0][1]) as unknown;
    } catch {
      return undefined;
    }
  }
}

if (import.meta.main) {
  const useCase = {
    requiredKeys: ["price", "sourceUrl"],
    minimumUrls: 1,
  };
  const response = 'Here is the result:\n```json\n{"price": 1, "sourceUrl": "https://example.com"}\n```';
  if (!validatesOutcome(response, useCase) || validatesOutcome("No JSON here.", useCase)) {
    throw new Error("Outcome grading self-check failed.");
  }
  console.log("Outcome grading self-check passed.");
}
