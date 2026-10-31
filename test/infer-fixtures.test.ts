// Inference fixtures: each folder in test/fixtures/infer holds a `samples/` folder and
// the OpenAPI that `mockgen infer` should write for it. See the README there for what
// each fixture covers.
//
// Every expected file was reviewed by hand. When inference deliberately changes,
// update with `npx vitest run test/infer-fixtures.test.ts -u`, review the diff, and
// say so in the commit.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatOpenApi, generate, loadOpenApi, loadSamples, type MockModel, parseSampleName, ResponseValidator } from '../src/index.js';

const ROOT = 'test/fixtures/infer';
const fixtures = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

/** Every sample file with its parsed route, read straight from disk. */
function samplesOf(dir: string) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .filter((rel) => !rel.split(path.sep).some((seg) => seg.startsWith('.') || seg === 'node_modules'))
    .flatMap((rel) => {
      const route = parseSampleName(rel);
      const text = fs.readFileSync(path.join(dir, rel), 'utf8').trim();
      if (!route || !text) return [];
      try {
        return [{ rel, route, body: JSON.parse(text) as unknown }];
      } catch {
        return [];
      }
    });
}

/** Warnings with the OS path separator and the JSON parser's (Node-version-specific) wording removed. */
const portable = (warnings: string[]) => warnings.map((w) => w.replaceAll('\\', '/').replace(/invalid JSON, skipped \(.*\)$/, 'invalid JSON, skipped (…)'));

it('has the 30 fixtures the plan asks for', () => {
  expect(fixtures.length).toBeGreaterThanOrEqual(30);
});

describe.each(fixtures)('%s', (name) => {
  const dir = path.join(ROOT, name);
  const samples = path.join(dir, 'samples');

  it('infers the expected OpenAPI', async () => {
    const model = await loadSamples(samples);
    await expect(formatOpenApi(model)).toMatchFileSnapshot(path.join('fixtures/infer', name, 'expected.openapi.yaml'));
    const warnings = portable(model.warnings);
    if (warnings.length || fs.existsSync(path.join(dir, 'expected.warnings.json'))) {
      await expect(`${JSON.stringify(warnings, null, 2)}\n`).toMatchFileSnapshot(path.join('fixtures/infer', name, 'expected.warnings.json'));
    }
  });

  it('accepts every one of its samples', async () => {
    const model = await loadSamples(samples);
    const validator = new ResponseValidator();
    for (const { rel, route, body } of samplesOf(samples)) {
      const match = model.routes.find((r) => r.method === route.method && r.path === route.path);
      const status = route.status ?? (route.method === 'POST' ? 201 : 200);
      const schema = match?.responses.find((r) => r.status === status)?.schema;
      expect(schema, `${rel}: no inferred schema`).toBeDefined();
      const result = validator.validate(schema!, body);
      expect(result.valid, `${rel}: ${result.errors}`).toBe(true);
    }
  });

  // `mockgen infer` exists so sample users can graduate to a spec: the written file
  // must load as one, with the same routes, and serve valid responses.
  it('round-trips through the written OpenAPI', async () => {
    const inferred = await loadSamples(samples);
    const spec = await loadOpenApi(path.join(dir, 'expected.openapi.yaml'));
    const routes = (m: MockModel) => m.routes.map((r) => `${r.method} ${r.path} ${r.responses.map((x) => x.status).join(',')}`).sort();
    expect(routes(spec)).toEqual(routes(inferred));

    const validator = new ResponseValidator(spec.openapi);
    for (const route of spec.routes) {
      for (const res of route.responses) {
        if (!res.schema) continue;
        for (const seed of [1, 2, 3]) {
          const body = generate(res.schema, { seed, key: `${route.method} ${route.path} ${res.status}` });
          const result = validator.validate(res.schema, body);
          expect(result.valid, `${route.method} ${route.path} ${res.status} seed ${seed}: ${result.errors}`).toBe(true);
        }
      }
    }
  });
});
