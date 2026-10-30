import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockServer, loadOpenApi, type MockServer } from '../src/index.js';

let mock: MockServer;
let url: string;

beforeAll(async () => {
  mock = await createMockServer({ spec: 'examples/petstore.yaml', seed: 1 });
  url = await mock.listen(0);
});
afterAll(() => mock.close());

// Bodies are untyped mock data; let tests poke at them freely.
type LooseResponse = Omit<Response, 'json'> & { json(): Promise<any> };
const get = (path: string, init?: RequestInit) => fetch(url + path, init) as Promise<LooseResponse>;

describe('mock server', () => {
  it('serves generated JSON for a list endpoint', async () => {
    const res = await get('/users');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(3);
    expect(body.data[0]).toHaveProperty('email');
  });

  it('returns the same data across requests and restarts', async () => {
    const a = await (await get('/users/7')).text();
    const b = await (await get('/users/7')).text();
    expect(a).toBe(b);

    const again = await createMockServer({ spec: 'examples/petstore.yaml', seed: 1 });
    const otherUrl = await again.listen(0);
    expect(await (await fetch(`${otherUrl}/users/7`)).text()).toBe(a);
    await again.close();
  });

  it('echoes path params into the record', async () => {
    const body = await (await get('/users/42')).json();
    expect(body.id).toBe(42);
  });

  it('matches literal paths before templated ones', async () => {
    const res = await get('/users/me');
    expect(res.status).toBe(200);
    expect((await res.json()).id).not.toBe('me');
  });

  it('accepts requests with or without the server base path', async () => {
    expect((await get('/v1/users')).status).toBe(200);
  });

  it('uses spec examples when present', async () => {
    expect((await (await get('/pets/1')).json()).name).toBe('Rex');
  });

  it('simulates errors with X-Mock-Status and ?__status', async () => {
    const res = await get('/users/1', { headers: { 'X-Mock-Status': '404' } });
    expect(res.status).toBe(404);
    expect(['not_found', 'invalid', 'conflict']).toContain((await res.json()).code);

    const undocumented = await get('/users/1?__status=503');
    expect(undocumented.status).toBe(503);
    expect((await undocumented.json()).error).toBe('Service Unavailable');
  });

  it('simulates latency with X-Mock-Delay', async () => {
    const t = performance.now();
    await get('/pets', { headers: { 'X-Mock-Delay': '150' } });
    expect(performance.now() - t).toBeGreaterThanOrEqual(140);
  });

  it('sends CORS headers and answers preflight', async () => {
    const res = await get('/users', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns 204 without a body', async () => {
    const res = await get('/users/1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('distinguishes unknown paths (404) from unknown methods (405)', async () => {
    expect((await get('/nope')).status).toBe(404);
    expect((await get('/pets', { method: 'PUT' })).status).toBe(405);
  });
});

describe('loadOpenApi', () => {
  it('resolves multi-file $refs and records source files', async () => {
    const model = await loadOpenApi('examples/petstore.yaml');
    expect(model.basePath).toBe('/v1');
    expect(model.sources.some((s) => s.endsWith('user.yaml'))).toBe(true);
  });

  it('names the file in load errors', async () => {
    await expect(loadOpenApi('examples/missing.yaml')).rejects.toThrow(/missing\.yaml/);
  });
});
