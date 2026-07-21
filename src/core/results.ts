import type {
  DatasetResult,
  DatasetResultBase,
  RequestContext,
} from "./contracts";

export type ResultStore = {
  save(
    result: DatasetResultBase,
    source: DatasetResult["rows"] | ResultSource,
    context: RequestContext,
  ): Promise<DatasetResult>;
  readResult(
    resultId: string,
    context: RequestContext,
  ): Promise<DatasetResult>;
  readPage(pageToken: string, context: RequestContext): Promise<DatasetResult>;
};

export type ResultSource = {
  partSize: number;
  totalRows?: number;
  expiresAt?: string;
  loadPart(part: number, context: RequestContext): Promise<DatasetResult["rows"]>;
};
