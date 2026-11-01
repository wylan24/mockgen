import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkOverrides, loadConfig, loadOpenApi, normalizeRoutes, respond, type MockModel, type RouteOverride } from '../src/index.js';

const SPEC = path.resolve('test/fixtures/stateful.yaml');
const CLI = path.resolve('src/cli.ts');

let dir: string;
let model: MockModel;

beforeAll(async () => {
  // Inside the repo, so `--import tsx` and `import type` resolve from here.
  dir = await fs.mkdtemp(path.join('test', '.tmp-config-'));
  model = await loadOpenApi(SPEC);
});
afterAll(() => fs.rm(dir, { recursive: true, force: true }));

const write = (name: string, text: string) => fs.writeFile(path.join(dir, name), text).then(() => path.join(dir, name));
const get = (path: string, overrides: Record<string, RouteOverride>, extra = {}) => respond(model, { method: 'GET', path, seed: 1, overrides, ...extra });

describe('loading a config file', () => {
  it('loads TypeScript with plain Node, no loader (what npx users rely on)', async () => {
    const file = await write(
      'native.config.ts',
      `import type { MockConfig } from '@wylan24/mockgen';
const config = { seed: 7, routes: { 'GET /items/{id}': { merge: { name: 'typed' } } } } satisfies MockConfig;
export default config;
`,
    );
    const script = `import(${JSON.stringify(pathToFileURL(path.resolve(file)).href)}).then((m) => console.log(JSON.stringify(m.default)))`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(run.stderr).not.toMatch(/Error/);
    expect(JSON.parse(run.stdout)).toEqual({ seed: 7, routes: { 'GET /items/{id}': { merge: { name: 'typed' } } } });
  });

  it('loads .ts, .mjs and .json', async () => {
    const ts = await write('a.config.ts', `export default { seed: 2, routes: { 'get /items': { delay: 5 } } };\n`);
    const mjs = await write('b.config.mjs', `export default { records: 3 };\n`);
    const json = await write('c.config.json', `{ "locale": "de", "stateful": true }\n`);
    expect(await loadConfig(ts)).toEqual({ seed: 2, routes: { 'get /items': { delay: 5 } } });
    expect(await loadConfig(mjs)).toEqual({ records: 3 });
    expect(await loadConfig(json)).toEqual({ locale: 'de', stateful: true });
  });

  it.each([
    ['{ "colour": 1 }', /unknown option "colour"/],
    ['{ "seed": "1" }', /"seed" must be a whole number/],
    ['{ "routes": { "users": {} } }', /keys look like "GET \/users\/\{id\}"/],
    ['{ "routes": { "GET /items": { "status": 700 } } }', /status must be an HTTP status code/],
    ['{ "routes": { "GET /items": { "bodyy": 1 } } }', /unknown option "bodyy"/],
    ['[1]', /must export a config object/],
  ])('rejects %s', async (text, message) => {
    const file = await write(`bad-${Math.random().toString(36).slice(2)}.json`, text);
    await expect(loadConfig(file)).rejects.toThrow(message);
  });

  it('names the file in errors, relative to the working directory', async () => {
    const file = await write('broken.config.json', '{ nope');
    await expect(loadConfig(file)).rejects.toThrow(/^test[\\/]\.tmp-config-\w+[\\/]broken\.config\.json: /);
  });
});

describe('checking overrides against the spec', () => {
  it('reports keys that match no route, listing the real ones', () => {
    const { errors } = checkOverrides(normalizeRoutes({ 'GET /item/{id}': { delay: 1 } }), model);
    expect(errors[0]).toMatch(/routes\["GET \/item\/\{id\}"\] matches no route.*GET \/items\/\{id\}/);
  });

  it('warns about fixed bodies that do not match the schema', () => {
    const { errors, warnings } = checkOverrides(normalizeRoutes({ 'get /items/{id}': { body: { id: 'x' } }, 'GET /tags': { body: [] } }), model);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/routes\["GET \/items\/\{id\}"\]\.body doesn't match the spec's 200 response/);
  });
});

describe('route overrides', () => {
  it('merges fields into the response, and into list items that mirror it', () => {
    const overrides = normalizeRoutes({ 'GET /items/{id}': { merge: { priority: 'high', name: 'Pinned' } } });
    const item = get('/items/4', overrides).body as Record<string, unknown>;
    expect(item).toMatchObject({ id: 4, priority: 'high', name: 'Pinned' });
    const list = get('/items', overrides, { query: 'limit=5' }).body as { data: Record<string, unknown>[] };
    expect(list.data.every((i) => i.priority === 'high' && i.name === 'Pinned')).toBe(true);
  });

  it('replaces the body with a fixed value or a function of the request', () => {
    const fixed = get('/tags', normalizeRoutes({ 'GET /tags': { body: [{ id: 'a', label: 'fixed' }] } }));
    expect(fixed).toMatchObject({ status: 200, body: [{ id: 'a', label: 'fixed' }] });

    const fn = get('/items/9', { 'GET /items/{id}': { body: ({ params, query }: { params: Record<string, string>; query: URLSearchParams }) => ({ id: Number(params.id), view: query.get('view') }) } }, { query: 'view=compact' });
    expect(fn.body).toEqual({ id: 9, view: 'compact' });
  });

  it('a status alone serves the spec response for that status', () => {
    const r = get('/items/1', normalizeRoutes({ 'GET /items/{id}': { status: 404 } }));
    expect(r.status).toBe(404);
    expect(r.body).toHaveProperty('code');
  });

  it('adds headers and a delay', () => {
    const r = get('/items/1', normalizeRoutes({ 'GET /items/{id}': { headers: { 'x-env': 'mock' }, delay: 250 } }));
    expect(r.headers['x-env']).toBe('mock');
    expect(r.delay).toBe(250);
  });

  it('X-Mock-Status on the request wins over the override', () => {
    const r = get('/items/1', normalizeRoutes({ 'GET /items/{id}': { body: { id: 1 }, status: 200 } }), { status: 500 });
    expect(r.status).toBe(500);
    expect(r.body).not.toEqual({ id: 1 });
  });

  it('leaves other routes alone', () => {
    const overrides = normalizeRoutes({ 'GET /tags': { body: [] } });
    expect(get('/items/1', overrides)).toEqual(get('/items/1', {}));
  });
});

describe('the CLI', { timeout: 30_000 }, () => {
  let child: ChildProcess | undefined;
  afterEach(() => child?.kill());

  /** Start `mockgen serve` in `cwd` and resolve with its URL and output. */
  function serve(cwd: string, args: string[]): Promise<{ url: string; output: () => string }> {
    const proc = spawn(process.execPath, ['--import', 'tsx', CLI, 'serve', SPEC, '--port', '0', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    let out = '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready line:\n${out}`)), 20_000);
      proc.on('exit', (code) => reject(new Error(`exited with ${code}:\n${out}`)));
      const onData = (d: Buffer) => {
        out += d.toString().replace(/\x1b\[[0-9;]*m/g, '');
        const url = out.match(/Mock server ready at (http:\/\/\S+)/)?.[1];
        if (url) {
          clearTimeout(timer);
          resolve({ url, output: () => out });
        }
      };
      proc.stdout!.on('data', onData);
      proc.stderr!.on('data', onData);
    });
  }

  it('finds mock.config.ts in the working directory; flags beat it', async () => {
    const cwd = await fs.mkdtemp(path.join(dir, 'cli-'));
    await fs.writeFile(path.join(cwd, 'mock.config.ts'), `export default { seed: 5, stateful: true, routes: { 'GET /items/{id}': { merge: { name: 'from config' } } } };\n`);
    const { url, output } = await serve(cwd, ['--seed', '9', '--no-watch']);
    expect(output()).toMatch(/config: mock\.config\.ts \(1 route override\)/);
    expect(output()).toMatch(/seed 9, stateful/);
    const item = (await (await fetch(`${url}/items/3`)).json()) as { name: string };
    expect(item.name).toBe('from config');
  });

  it('fails clearly on a route key that matches nothing', async () => {
    const cwd = await fs.mkdtemp(path.join(dir, 'cli-'));
    await fs.writeFile(path.join(cwd, 'mock.config.json'), `{ "routes": { "GET /itemz": { "delay": 1 } } }\n`);
    const run = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'serve', SPEC, '--port', '0', '--no-watch'], { cwd, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/routes\["GET \/itemz"\] matches no route/);
  });
});
