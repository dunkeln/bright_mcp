import type { DatasetResult, RequestContext } from "./contracts";

export type ResultStore = {
  save(
    result: Omit<DatasetResult, "rows" | "rowRefs" | "page" | "artifact">,
    rows: DatasetResult["rows"],
    context: RequestContext,
  ): DatasetResult;
  readResult(resultId: string, principalId: string): DatasetResult;
  readPage(pageToken: string, principalId: string): DatasetResult;
};
