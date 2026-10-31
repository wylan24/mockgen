// Determinism: the same spec + seed must produce byte-identical output on every OS
// and Node version. CI runs this on macOS, Linux and Windows with Node 22 and 24,
// all against the same committed snapshots, so any platform drift fails the build.
//
// A snapshot changing is expected when generation deliberately changes; review the
// diff, then update with `npx vitest run -u` and say so in the commit.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { formatOpenApi, loadSamples, loadSource, respond, type MockModel } from '../src/index.js';

/** Everything a client can see: each route's every status, list pages, and seeds. */
function served(model: MockModel, seeds = [1, 2]) {
  const out: Record<string, unknown> = {};
  for (const route of model.routes) {
    const path = route.path.replace(/\{[^}]+\}/g, '42');
    for (const res of route.responses) {
      for (const seed of seeds) {
        const r = respond(model, { method: route.method, path, seed, status: res.status, origin: 'http://localhost:4010' });
        out[`${route.method} ${path} ${res.status} seed=${seed}`] = { body: r.body, headers: r.headers };
      }
    }
    if (route.method === 'GET' && !route.path.endsWith('}')) {
      const r = respond(model, { method: 'GET', path, seed: seeds[0], query: 'page=3&limit=4', origin: 'http://localhost:4010' });
      out[`GET ${path}?page=3&limit=4 seed=${seeds[0]}`] = { body: r.body, headers: r.headers };
    }
  }
  return out;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

describe('deterministic output', () => {
  it('OpenAPI example matches its snapshot', async () => {
    await expect(json(served(await loadSource('examples/petstore.yaml')))).toMatchFileSnapshot('__snapshots__/petstore.served.json');
  });

  it('sample folder matches its snapshot', async () => {
    await expect(json(served(await loadSource('examples/samples')))).toMatchFileSnapshot('__snapshots__/samples.served.json');
  });

  it('inferred OpenAPI matches its snapshot', async () => {
    await expect(formatOpenApi(await loadSamples('examples/samples'))).toMatchFileSnapshot('__snapshots__/samples.openapi.yaml');
  });

  it('a large generation run hashes the same everywhere', async () => {
    // Thousands of values through every generator path, reduced to one hash so the
    // snapshot stays small; the snapshots above show what changed when it differs.
    const hash = createHash('sha256');
    for (const source of ['examples/petstore.yaml', 'examples/samples']) {
      const model = await loadSource(source);
      for (let seed = 3; seed <= 150; seed++) for (const [k, v] of Object.entries(served(model, [seed]))) hash.update(k).update(JSON.stringify(v) ?? '');
    }
    expect(hash.digest('hex')).toMatchInlineSnapshot(`"e7c5bcfcc7d4a20c51d3bbe68d3e05bb9434cafb68f0cd971b6cdcee52f4b95d"`);
  });
});
