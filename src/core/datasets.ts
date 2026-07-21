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

export function createDatasetUseCases(dependencies: {
  catalog: DatasetCatalog;
  runner: DatasetRunner;
}) {
  return {
    findDatasets: (query: string, limit: number, context: RequestContext) =>
      dependencies.catalog.find(query, limit, context),
    describeDataset: (datasetId: string, context: RequestContext) =>
      dependencies.catalog.describe(datasetId, context),
    runDataset: (
      input: {
        datasetId: string;
        operation: DatasetOperation;
        arguments: JsonObject;
      },
      context: RequestContext,
    ) => dependencies.runner.run(input, context),
  };
}

export type DatasetUseCases = ReturnType<typeof createDatasetUseCases>;
