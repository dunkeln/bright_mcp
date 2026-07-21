import type {
  DatasetDefinition,
  DatasetOperation,
  DatasetResult,
  DatasetSummary,
  JsonObject,
  RequestContext,
} from "./contracts";

export type DatasetCatalog = {
  find(
    query: string,
    limit: number,
    context: RequestContext,
  ): Promise<DatasetSummary[]>;
  describe(
    datasetId: string,
    context: RequestContext,
  ): Promise<DatasetDefinition>;
};

export type DatasetRunner = {
  run(
    input: {
      datasetId: string;
      operation: DatasetOperation;
      arguments: JsonObject;
    },
    context: RequestContext,
  ): Promise<DatasetResult>;
};

export type DatasetAdapter = {
  catalog: DatasetCatalog;
  runner: DatasetRunner;
};
