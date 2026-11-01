import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, loadOpenApi, MockState, respond, ResponseValidator, type MockModel, type MockServer } from '../src/index.js';

const SPEC = 'test/fixtures/stateful.yaml';

let mock: MockServer;
let url: string;
let model: MockModel;

beforeAll(async () => {
  model = await loadOpenApi(SPEC);
  mock = await createMockServer({ model, seed: 1, stateful: true });
  url = await mock.listen(0);
});
afterAll(() => mock.close());
beforeEach(() => mock.reset());

// Bodies are untyped mock data; let tests poke at them freely.
type Loose = { status: number; headers: Headers; body: any };
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Loose> {
  const res = await fetch(url + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}
const list = async (query = 'limit=100') => (await call('GET', `/items?${query}`)).body as { data: { id: number; name: string }[]; total: number };

describe('stateful mode', () => {
  it('creates a record that the detail route and the list then return', async () => {
    const created = await call('POST', '/items', { name: 'Write the docs', done: false });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 51, name: 'Write the docs', done: false });
    expect(created.headers.get('location')).toBe('/items/51');

    expect((await call('GET', '/items/51')).body).toEqual(created.body);
    const all = await list();
    expect(all.total).toBe(51);
    expect(all.data.at(-1)).toEqual(created.body);
    expect((await call('GET', '/items?limit=100')).headers.get('x-total-count')).toBe('51');
  });

  it('gives each new record the next id', async () => {
    const ids = [];
    for (const name of ['a', 'b', 'c']) ids.push((await call('POST', '/items', { name })).body.id);
    expect(ids).toEqual([51, 52, 53]);
  });

  it('updates generated records with PATCH and PUT, everywhere they appear', async () => {
    const before = (await call('GET', '/items/3')).body;
    const patched = await call('PATCH', '/items/3', { done: true, name: 'Renamed' });
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({ ...before, done: true, name: 'Renamed' });
    expect((await call('GET', '/items/3')).body).toEqual(patched.body);
    expect((await list()).data.find((i) => i.id === 3)).toEqual(patched.body);

    const put = await call('PUT', '/items/3', { priority: 'low' });
    expect(put.body).toEqual({ ...patched.body, priority: 'low' });
  });

  it('updates created records', async () => {
    const { id } = (await call('POST', '/items', { name: 'Draft' })).body;
    await call('PATCH', `/items/${id}`, { name: 'Final' });
    expect((await call('GET', `/items/${id}`)).body.name).toBe('Final');
    expect((await list()).data.at(-1)!.name).toBe('Final');
  });

  it('deletes records: 404 afterwards, and the list shrinks', async () => {
    expect((await call('DELETE', '/items/5')).status).toBe(204);
    const gone = await call('GET', '/items/5');
    expect(gone.status).toBe(404);
    expect(gone.body).toHaveProperty('code'); // the spec's 404 schema
    const all = await list();
    expect(all.total).toBe(49);
    expect(all.data.map((i) => i.id)).not.toContain(5);
    expect((await call('DELETE', '/items/5')).status).toBe(404);
    expect((await call('PATCH', '/items/5', { done: true })).status).toBe(404);
  });

  it('pages over the changed collection', async () => {
    await call('DELETE', '/items/1');
    await call('POST', '/items', { name: 'New' });
    const page5 = await list('page=5&limit=10');
    expect(page5.data.map((i) => i.id)).toEqual([42, 43, 44, 45, 46, 47, 48, 49, 50, 51]);
    expect((await list('page=6&limit=10')).data).toEqual([]);
  });

  it('answers 404 for ids that were never in the collection', async () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) expect((await call(method, '/items/999', method === 'GET' || method === 'DELETE' ? undefined : {})).status).toBe(404);
  });

  it('ignores the id, read-only fields, unknown fields and values that break the schema', async () => {
    const created = (await call('POST', '/items', { id: 7, createdAt: '2000-01-01T00:00:00Z', colour: 'red', priority: 'urgent', name: 'Kept' })).body;
    expect(created.id).toBe(51);
    expect(created.createdAt).not.toBe('2000-01-01T00:00:00Z');
    expect(created).not.toHaveProperty('colour');
    expect(['low', 'high']).toContain(created.priority);
    expect(created.name).toBe('Kept');

    const validator = new ResponseValidator();
    const item = model.routes.find((r) => r.method === 'GET' && r.path === '/items/{id}')!.responses[0]!.schema!;
    expect(validator.validate(item, created).valid).toBe(true);
  });

  it('uses generated ids for non-numeric id schemas', async () => {
    const tags = (await call('GET', '/tags?limit=100')).body as { id: string }[];
    const created = (await call('POST', '/tags', { label: 'urgent' })).body;
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tags.map((t) => t.id)).not.toContain(created.id);
    expect((await call('GET', `/tags/${created.id}`)).body).toEqual(created);
    expect((await call('DELETE', `/tags/${tags[0]!.id}`)).status).toBe(204);
    expect((await call('GET', `/tags/${tags[0]!.id}`)).status).toBe(404);
  });

  it('rejects bodies that are not JSON objects', async () => {
    expect((await call('POST', '/items', '{not json')).status).toBe(400);
    expect((await call('POST', '/items', [1, 2])).status).toBe(400);
    expect((await call('PATCH', '/items/1', '"text"')).status).toBe(400);
  });

  it('never changes state for a forced status', async () => {
    expect((await call('DELETE', '/items/2', undefined, { 'X-Mock-Status': '500' })).status).toBe(500);
    expect((await call('POST', '/items', { name: 'x' }, { 'X-Mock-Status': '422' })).status).toBe(422);
    expect((await call('GET', '/items/2')).status).toBe(200);
    expect((await list()).total).toBe(50);
  });

  it('resets with POST /__mockgen/reset and with mock.reset()', async () => {
    await call('DELETE', '/items/2');
    expect((await call('POST', '/__mockgen/reset')).status).toBe(204);
    expect((await list()).total).toBe(50);
    await call('POST', '/items', { name: 'x' });
    mock.reset();
    expect((await list()).total).toBe(50);
  });

  it('is deterministic: the same requests give the same responses', async () => {
    const run = async () => [
      (await call('POST', '/items', { name: 'x' })).body,
      (await call('PATCH', '/items/9', { done: true })).body,
      (await list('page=5&limit=10')).data,
    ];
    const first = await run();
    mock.reset();
    expect(await run()).toEqual(first);
  });

  it('works through respond() with a MockState', () => {
    const state = new MockState();
    const created = respond(model, { method: 'POST', path: '/items', seed: 1, state, body: { name: 'Direct' } });
    expect(created.status).toBe(201);
    expect(respond(model, { method: 'GET', path: `/items/${(created.body as { id: number }).id}`, seed: 1, state }).body).toEqual(created.body);
  });
});

describe('stateless mode (the default)', () => {
  it('does not remember anything', async () => {
    const plain = await createMockServer({ spec: SPEC, seed: 1 });
    const plainUrl = await plain.listen(0);
    try {
      const before = await (await fetch(`${plainUrl}/items/5`)).text();
      expect((await fetch(`${plainUrl}/items/5`, { method: 'DELETE' })).status).toBe(204);
      expect(await (await fetch(`${plainUrl}/items/5`)).text()).toBe(before);
      expect((await fetch(`${plainUrl}/__mockgen/reset`, { method: 'POST' })).status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
