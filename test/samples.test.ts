import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockServer, formatOpenApi, loadOpenApi, loadSamples, parseSampleName, type MockServer } from '../src/index.js';

const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);

const SAMPLES = 'examples/samples';

describe('parseSampleName', () => {
  it.each([
    ['GET.users.json', { method: 'GET', path: '/users', status: undefined }],
    ['get.users.json', { method: 'GET', path: '/users', status: undefined }],
    ['GET.json', { method: 'GET', path: '/', status: undefined }],
    ['GET.users.[id].json', { method: 'GET', path: '/users/{id}', status: undefined }],
    ['GET.users.{id}.posts.json', { method: 'GET', path: '/users/{id}/posts', status: undefined }],
    [path.join('users', '[id]', 'GET.posts.json'), { method: 'GET', path: '/users/{id}/posts', status: undefined }],
    ['GET.users.[id].404.json', { method: 'GET', path: '/users/{id}', status: 404 }],
    ['GET.users.[id]~alice.json', { method: 'GET', path: '/users/{id}', status: undefined }],
    ['POST.users.422~bad-email.json', { method: 'POST', path: '/users', status: 422 }],
  ])('%s', (name, expected) => {
    expect(parseSampleName(name)).toEqual(expected);
  });

  it.each(['users.json', 'FETCH.users.json', 'GET.users.yaml', 'GET..users.json'])('rejects %s', (name) => {
    expect(parseSampleName(name)).toBeUndefined();
  });
});

describe('loadSamples', () => {
  it('builds routes and statuses from the example folder', async () => {
    const model = await loadSamples(SAMPLES);
    const routes = model.routes.map((r) => `${r.method} ${r.path} ${r.responses.map((x) => x.status).join(',')}`);
    expect(routes.sort()).toEqual(['DELETE /users/{id} 204', 'GET /users 200', 'GET /users/{id} 200,404', 'POST /users 201']);
    expect(model.warnings).toEqual([]);
  });

  it('merges every sample for a route into one schema', async () => {
    const model = await loadSamples(SAMPLES);
    const schema = model.routes.find((r) => r.method === 'GET' && r.path === '/users/{id}')!.responses[0]!.schema!;
    // `lastLoginAt` appears in only one of the two samples; `bio` is null in one.
    expect(schema.required).not.toContain('lastLoginAt');
    expect(schema.properties.bio.type).toEqual(['string', 'null']);
  });

  it('every sample validates against its inferred schema', async () => {
    const model = await loadSamples(SAMPLES);
    for (const file of await fs.readdir(SAMPLES, { recursive: true })) {
      const full = path.join(SAMPLES, file);
      const text = (await fs.stat(full)).isFile() ? (await fs.readFile(full, 'utf8')).trim() : '';
      if (!text) continue;
      const parsed = parseSampleName(file)!;
      const route = model.routes.find((r) => r.method === parsed.method && r.path === parsed.path)!;
      const res = route.responses.find((r) => r.status === (parsed.status ?? (parsed.method === 'POST' ? 201 : 200)))!;
      const validate = ajv.compile(res.schema!);
      expect(validate(JSON.parse(text)), `${file}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it('warns about, and skips, misnamed files and invalid JSON', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mockgen-'));
    await fs.writeFile(path.join(dir, 'GET.ok.json'), '{"a":1}');
    await fs.writeFile(path.join(dir, 'users.json'), '[]');
    await fs.writeFile(path.join(dir, 'GET.broken.json'), '{nope');
    const model = await loadSamples(dir);
    expect(model.routes.map((r) => r.path)).toEqual(['/ok']);
    expect(model.warnings).toHaveLength(2);
    expect(model.warnings.join('\n')).toMatch(/users\.json.*ignored/);
    expect(model.warnings.join('\n')).toMatch(/GET\.broken\.json.*invalid JSON/);
    await fs.rm(dir, { recursive: true });
  });

  it('loads a sample folder that lives inside a dot-folder', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mockgen-'));
    const dir = path.join(parent, '.mocks');
    await fs.mkdir(path.join(dir, '.drafts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'GET.ok.json'), '{"a":1}');
    await fs.writeFile(path.join(dir, '.drafts', 'GET.draft.json'), '{"a":1}');
    const model = await loadSamples(dir);
    // Dot-folders *inside* the sample folder are still skipped.
    expect(model.routes.map((r) => r.path)).toEqual(['/ok']);
    await fs.rm(parent, { recursive: true });
  });
});

describe('infer → OpenAPI', () => {
  it('writes a spec that loads back into the same routes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mockgen-'));
    const model = await loadSamples(SAMPLES);
    for (const ext of ['yaml', 'json']) {
      const file = path.join(dir, `openapi.${ext}`);
      await fs.writeFile(file, formatOpenApi(model, file));
      const back = await loadOpenApi(file);
      const summarize = (m: typeof model) => m.routes.map((r) => `${r.method} ${r.path} ${r.responses.map((x) => x.status)}`).sort();
      expect(summarize(back)).toEqual(summarize(model));
    }
    await fs.rm(dir, { recursive: true });
  });
});

describe('serving a sample folder', () => {
  let mock: MockServer;
  let url: string;
  beforeAll(async () => {
    mock = await createMockServer({ spec: SAMPLES, seed: 1 });
    url = await mock.listen(0);
  });
  afterAll(() => mock.close());

  it('generates new records shaped like the samples', async () => {
    const res = await fetch(`${url}/users/42`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.id).toBe(42);
    expect(body.email).toMatch(/@/);
    expect(body.name).not.toBe('Ada Lovelace');
  });

  it('serves sample error responses and empty-file 204s', async () => {
    expect((await fetch(`${url}/users/1`, { headers: { 'X-Mock-Status': '404' } })).status).toBe(404);
    expect((await fetch(`${url}/users/1`, { method: 'DELETE' })).status).toBe(204);
  });
});
