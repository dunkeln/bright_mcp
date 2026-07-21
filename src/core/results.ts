import type {
  DatasetResult,
  DatasetResultBase,
  RequestContext,
} from "./contracts";

export type ResultStore = {
  save(
    result: DatasetResultBase,
    rows: DatasetResult["rows"],
    context: RequestContext,
  ): DatasetResult;
  readResult(resultId: string, principalId: string): DatasetResult;
  readPage(pageToken: string, principalId: string): DatasetResult;
};
