import type {
  DatasetDefinition,
  DatasetOperation,
  DatasetResult,
  DatasetSummary,
  JsonObject,
  RequestContext,
} from "./contracts";

export type DatasetCatalog = {
  find(query: string, limit: number): Promise<DatasetSummary[]>;
  describe(datasetId: string): Promise<DatasetDefinition>;
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
    findDatasets: (query: string, limit = 5) =>
      dependencies.catalog.find(query, limit),
    describeDataset: (datasetId: string) =>
      dependencies.catalog.describe(datasetId),
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
