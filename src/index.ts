import { loadSource } from './load.js';
import { createMockServer as createServer, type MockServer, type MockServerOptions } from './server.js';

export { availableLocales, generate, type GenerateOptions } from './generate.js';
export type { MockModel, MockResponse, MockRoute, Schema } from './model.js';
export { inferSchema, SchemaInferrer } from './infer.js';
export { loadSource } from './load.js';
export { loadOpenApi, SpecLoadError } from './openapi.js';
export { formatOpenApi, loadSamples, parseSampleName, toOpenApi } from './samples.js';
export { ResponseValidator, toJsonSchema, type ValidationResult } from './validate.js';
export { respond, type MockResult, type MockServer, type MockServerOptions, type RespondInput } from './server.js';
export { MockState } from './state.js';
export { CONFIG_FILES, checkOverrides, ConfigError, defineConfig, findConfig, loadConfig, normalizeRoutes, type JsonValue, type MockConfig, type RouteContext, type RouteOverride } from './config.js';

/**
 * Create a mock server from a spec path, a sample folder, or an already-loaded model.
 *
 * ```ts
 * const mock = await createMockServer({ spec: './openapi.yaml' });
 * const url = await mock.listen(0);
 * ```
 */
export async function createMockServer(
  options: Omit<MockServerOptions, 'model'> & ({ spec: string } | { model: MockServerOptions['model'] }),
): Promise<MockServer> {
  const model = 'model' in options ? options.model : await loadSource(options.spec);
  return createServer({ ...options, model });
}
