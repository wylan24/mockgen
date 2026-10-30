// The normalized model every input (OpenAPI spec, sample folder) is converted into.
// The generator and server only ever see this, never the original source.

/** An OpenAPI / JSON Schema schema object, already dereferenced. May contain cycles. */
export type Schema = Record<string, any>;

export interface MockResponse {
  status: number;
  /** True when this came from the spec's `default` response rather than an explicit code. */
  isDefault?: boolean;
  schema?: Schema;
  /** A concrete example from the spec; preferred over generated data. */
  example?: unknown;
  hasExample: boolean;
  contentType?: string;
}

export interface MockRoute {
  method: string;
  /** Path template as written in the spec, e.g. `/users/{id}`. */
  path: string;
  pattern: RegExp;
  paramNames: string[];
  operationId?: string;
  responses: MockResponse[];
}

export interface MockModel {
  title: string;
  version: string;
  /** Path prefix from `servers[0].url`, e.g. `/v1`; requests may include or omit it. */
  basePath: string;
  routes: MockRoute[];
  /** Non-fatal problems found while loading (lenient mode). */
  warnings: string[];
  /** Files the model was built from, for hot reload. */
  sources: string[];
}
