import { loadOpenApi } from './openapi.js';
import { createMockServer as createServer, type MockServer, type MockServerOptions } from './server.js';

export { generate, type GenerateOptions } from './generate.js';
export type { MockModel, MockResponse, MockRoute, Schema } from './model.js';
export { loadOpenApi, SpecLoadError } from './openapi.js';
export { respond, type MockResult, type MockServer, type MockServerOptions, type RespondInput } from './server.js';

/**
 * Create a mock server from a spec path or an already-loaded model.
 *
 * ```ts
 * const mock = await createMockServer({ spec: './openapi.yaml' });
 * const url = await mock.listen(0);
 * ```
 */
export async function createMockServer(
  options: Omit<MockServerOptions, 'model'> & ({ spec: string } | { model: MockServerOptions['model'] }),
): Promise<MockServer> {
  const model = 'model' in options ? options.model : await loadOpenApi(options.spec);
  return createServer({ ...options, model });
}
