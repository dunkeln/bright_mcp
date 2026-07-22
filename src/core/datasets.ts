import type {
  DatasetDefinition,
  DatasetResult,
  RequestContext,
} from "./contracts";
import type { DatasetExecutionInput } from "./dataset-inputs";

export type DatasetCatalog = {
  find(
    query: string,
    limit: number,
    context: RequestContext,
  ): Promise<DatasetDefinition[]>;
  describe(
    datasetId: string,
    context: RequestContext,
  ): Promise<DatasetDefinition>;
};

export type DatasetRunner = {
  run(
    input: DatasetExecutionInput,
    context: RequestContext,
  ): Promise<DatasetResult>;
};

export type DatasetAdapter = {
  catalog: DatasetCatalog;
  runner: DatasetRunner;
};
