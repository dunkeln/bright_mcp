import { LRUCache } from "lru-cache";
import {
  CapabilityError,
  type DatasetResult,
  type DatasetResultBase,
  type RequestContext,
} from "../core/contracts";
import { profileDataset } from "../core/profiles";
import type { ResultSource, ResultStore } from "../core/results";
import type { WebContentStore } from "../core/web";

const PAGE_ROWS = 8;
const PROFILE_ROWS = 1_000;
const RESULT_TTL_MS = 15 * 60 * 1000;
const WEB_PREVIEW_BYTES = 40_000;

type StoredResult = {
  owner: string;
  base: Omit<DatasetResult, "rows" | "rowRefs" | "page" | "artifact">;
  source: ResultSource;
  expiresAt: string;
  parts: Map<number, DatasetResult["rows"]>;
};

type StoredPage = { owner: string; resultId: string; offset: number };

export class LocalResultStore implements ResultStore {
  private readonly results = new LRUCache<string, StoredResult>({
    max: 100,
    ttl: RESULT_TTL_MS,
  });
  private readonly pages = new LRUCache<string, StoredPage>({
    max: 2_000,
    ttl: RESULT_TTL_MS,
  });

  async save(
    base: DatasetResultBase,
    input: DatasetResult["rows"] | ResultSource,
    context: RequestContext,
  ): Promise<DatasetResult> {
    const source = Array.isArray(input) ? arraySource(input) : input;
    const firstPart = await source.loadPart(1, context);
    const expiresAt = source.expiresAt ?? new Date(Date.now() + RESULT_TTL_MS).toISOString();
    const stored: StoredResult = {
      owner: context.principalId,
      expiresAt,
      source,
      parts: new Map([[1, firstPart]]),
      base: {
        ...base,
        profiles: profileDataset(base.columns, firstPart.slice(0, PROFILE_ROWS)),
      },
    };
    this.results.set(base.resultId, stored);
    return this.render(stored, 0, context);
  }

  async readResult(resultId: string, context: RequestContext): Promise<DatasetResult> {
    return this.render(this.ownedResult(resultId, context.principalId), 0, context);
  }

  async readPage(pageToken: string, context: RequestContext): Promise<DatasetResult> {
    const page = this.pages.get(pageToken);
    if (!page || page.owner !== context.principalId) throw resultNotFound();
    return this.render(
      this.ownedResult(page.resultId, context.principalId),
      page.offset,
      context,
    );
  }

  private async render(
    stored: StoredResult,
    offset: number,
    context: RequestContext,
  ): Promise<DatasetResult> {
    const part = Math.floor(offset / stored.source.partSize) + 1;
    const partOffset = offset % stored.source.partSize;
    let rows = stored.parts.get(part);
    if (!rows) {
      rows = await stored.source.loadPart(part, context);
      stored.parts.set(part, rows);
    }
    rows = rows.slice(partOffset, partOffset + PAGE_ROWS);
    const nextOffset = offset + rows.length;
    const hasNext = stored.source.totalRows === undefined
      ? rows.length === PAGE_ROWS
      : nextOffset < stored.source.totalRows;

    return {
      ...stored.base,
      rows,
      rowRefs: rows.map((_, index) => this.rowRef(stored.base.resultId, offset + index)),
      page: {
        nextResourceUri: hasNext ? this.createPage(stored, nextOffset) : undefined,
        truncated: hasNext,
        totalRows: stored.source.totalRows,
      },
      artifact: {
        uri: `brightdata://results/${stored.base.resultId}`,
        mediaType: "application/json",
        expiresAt: stored.expiresAt,
      },
    };
  }

  private createPage(stored: StoredResult, offset: number) {
    const token = crypto.randomUUID().replaceAll("-", "");
    this.pages.set(token, {
      owner: stored.owner,
      resultId: stored.base.resultId,
      offset,
    });
    return `brightdata://pages/${token}`;
  }

  private rowRef(resultId: string, ordinal: number) {
    return `r_${Bun.hash.wyhash(`${resultId}\0${ordinal}`, 0n).toString(36)}`;
  }

  private ownedResult(resultId: string, principalId: string) {
    const result = this.results.get(resultId);
    if (!result || result.owner !== principalId) throw resultNotFound();
    return result;
  }
}

export class LocalWebContentStore implements WebContentStore {
  private readonly pages = new LRUCache<
    string,
    { owner: string; url: string; content: string }
  >({ max: 500, ttl: RESULT_TTL_MS });

  save(url: string, content: string, context: RequestContext) {
    const token = crypto.randomUUID().replaceAll("-", "");
    this.pages.set(token, { owner: context.principalId, url, content });
    const bytes = new TextEncoder().encode(content);
    const truncated = bytes.byteLength > WEB_PREVIEW_BYTES;
    return {
      content: truncated
        ? new TextDecoder().decode(bytes.slice(0, WEB_PREVIEW_BYTES))
        : content,
      resourceUri: `brightdata://web/${token}`,
      truncated,
    };
  }

  read(token: string, context: RequestContext) {
    const page = this.pages.get(token);
    if (!page || page.owner !== context.principalId) throw resultNotFound();
    return { url: page.url, content: page.content };
  }
}

function arraySource(rows: DatasetResult["rows"]): ResultSource {
  return {
    partSize: Math.max(rows.length, 1),
    totalRows: rows.length,
    async loadPart(part) {
      return part === 1 ? rows : [];
    },
  };
}

function resultNotFound() {
  return new CapabilityError(
    "result_not_found",
    "This result was not found or has expired.",
    false,
    "Repeat the originating tool call to create a fresh transient result.",
  );
}
