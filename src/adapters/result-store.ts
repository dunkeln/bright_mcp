import { LRUCache } from "lru-cache";
import {
  CapabilityError,
  type DatasetResult,
  type RequestContext,
} from "../core/contracts";
import type { ResultStore } from "../core/results";

const PREVIEW_ROWS = 8;
const PAGE_ROWS = 8;
const RESULT_TTL_MS = 15 * 60 * 1000;

type StoredResult = {
  owner: string;
  expiresAt: string;
  base: Omit<DatasetResult, "rows" | "rowRefs" | "page" | "artifact">;
  rows: DatasetResult["rows"];
};

type StoredPage = { owner: string; resultId: string; offset: number };

export class LocalResultStore implements ResultStore {
  private readonly results = new LRUCache<string, StoredResult>({
    max: 100,
    ttl: RESULT_TTL_MS,
  });
  private readonly pages = new LRUCache<string, StoredPage>({
    max: 500,
    ttl: RESULT_TTL_MS,
  });

  save(
    base: StoredResult["base"],
    rows: DatasetResult["rows"],
    context: RequestContext,
  ): DatasetResult {
    const expiresAt = new Date(Date.now() + RESULT_TTL_MS).toISOString();
    this.results.set(base.resultId, {
      owner: context.principalId,
      expiresAt,
      base,
      rows,
    });
    return this.page(base.resultId, 0, PREVIEW_ROWS);
  }

  readResult(resultId: string, principalId: string): DatasetResult {
    const stored = this.ownedResult(resultId, principalId);
    return this.render(stored, 0, stored.rows.length);
  }

  readPage(pageToken: string, principalId: string): DatasetResult {
    const page = this.pages.get(pageToken);
    if (!page || page.owner !== principalId) {
      throw new CapabilityError(
        "result_not_found",
        "This result page was not found or has expired.",
        false,
        "Run the dataset again to create a fresh result.",
      );
    }
    this.ownedResult(page.resultId, principalId);
    return this.page(page.resultId, page.offset, PAGE_ROWS);
  }

  private page(resultId: string, offset: number, count: number): DatasetResult {
    const stored = this.results.get(resultId);
    if (!stored) {
      throw new CapabilityError("result_not_found", "This result has expired.");
    }
    return this.render(stored, offset, count);
  }

  private render(
    stored: StoredResult,
    offset: number,
    count: number,
  ): DatasetResult {
    const rows = stored.rows.slice(offset, offset + count);
    const nextOffset = offset + rows.length;
    const nextResourceUri =
      nextOffset < stored.rows.length
        ? this.createPage(stored, nextOffset)
        : undefined;

    return {
      ...stored.base,
      rows,
      rowRefs: rows.map((_, index) =>
        this.rowRef(stored.base.resultId, offset + index),
      ),
      page: {
        nextResourceUri,
        truncated: nextOffset < stored.rows.length,
        totalRows: stored.rows.length,
      },
      artifact: {
        uri: `brightdata://results/${stored.base.resultId}`,
        mediaType: "application/json",
        expiresAt: stored.expiresAt,
      },
    };
  }

  private createPage(stored: StoredResult, offset: number): string {
    const token = crypto.randomUUID().replaceAll("-", "");
    this.pages.set(token, {
      owner: stored.owner,
      resultId: stored.base.resultId,
      offset,
    });
    return `brightdata://pages/${token}`;
  }

  private rowRef(resultId: string, ordinal: number): string {
    const value = Bun.hash.wyhash(`${resultId}\0${ordinal}`, 0n);
    return `r_${value.toString(36)}`;
  }

  private ownedResult(resultId: string, principalId: string): StoredResult {
    const result = this.results.get(resultId);
    if (!result || result.owner !== principalId) {
      throw new CapabilityError(
        "result_not_found",
        "This result was not found or has expired.",
        false,
        "Run the dataset again to create a fresh result.",
      );
    }
    return result;
  }
}
