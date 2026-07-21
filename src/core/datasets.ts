import type {
  DatasetDefinition,
  DatasetResult,
  DatasetSummary,
  RequestContext,
} from "./contracts";
import type { DatasetRunInput } from "./dataset-inputs";

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
    input: DatasetRunInput,
    context: RequestContext,
  ): Promise<DatasetResult>;
};

export type DatasetAdapter = {
  catalog: DatasetCatalog;
  runner: DatasetRunner;
};
