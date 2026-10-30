import fs from 'node:fs/promises';
import type { MockModel } from './model.js';
import { loadOpenApi, SpecLoadError } from './openapi.js';
import { loadSamples } from './samples.js';

/** Load either input: an OpenAPI file, or a folder of sample responses. */
export async function loadSource(source: string): Promise<MockModel> {
  let stat;
  try {
    stat = await fs.stat(source);
  } catch {
    throw new SpecLoadError('no such file or folder', source);
  }
  return stat.isDirectory() ? loadSamples(source) : loadOpenApi(source);
}
