import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkRequest, createMockServer, loadOpenApi, ResponseValidator, type MockServer } from '../src/index.js';

const SPEC = 'test/fixtures/requests.yaml';

let mock: MockServer;
let url: string;

beforeAll(async () => {
  mock = await createMockServer({ spec: SPEC, seed: 1, validateRequests: true });
  url = await mock.listen(0);
});
afterAll(() => mock.close());

// Bodies are untyped mock data; let tests poke at them freely.
type Loose = { status: number; headers: Headers; body: any };
async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Loose> {
  const res = await fetch(url + p, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}
const searchHeaders = { 'x-request-id': '7c9e6679-7425-40de-944b-e07fc1f90ae7', accept: 'application/json' };

describe('request validation', () => {
  it('accepts valid requests, without the readOnly fields', async () => {
    expect((await call('GET', '/items?limit=5&tags=a,b&active=true')).status).toBe(200);
    expect((await call('GET', '/items?tags=a&tags=b')).status).toBe(200);
    expect((await call('GET', '/items/3')).status).toBe(200);
    expect((await call('POST', '/items', { title: 'Milk', priority: 'low' })).status).toBe(201);
    expect((await call('GET', '/search?q=ab', undefined, searchHeaders)).status).toBe(200);
  });

  it('rejects path parameters of the wrong type, with a generated 400 listing the problem', async () => {
    const r = await call('GET', '/items/abc');
    expect(r.status).toBe(400);
    expect(r.body.errors).toEqual([{ in: 'path', name: 'id', message: 'must be integer' }]);
    expect(r.headers.get('x-mock-validation')).toBe('path id: must be integer');
    expect((await call('GET', '/items/0')).headers.get('x-mock-validation')).toBe('path id: must be >= 1');
  });

  it('checks query parameters after converting them from text', async () => {
    expect((await call('GET', '/items?limit=500')).headers.get('x-mock-validation')).toBe('query limit: must be <= 50');
    expect((await call('GET', '/items?active=yes')).headers.get('x-mock-validation')).toBe('query active: must be boolean');
    expect((await call('GET', '/search?q=a', undefined, searchHeaders)).headers.get('x-mock-validation')).toMatch(/^query q: must NOT have fewer than 2 characters$/);
  });

  it('requires required query parameters and headers, case-insensitively', async () => {
    const r = await call('GET', '/search');
    expect(r.status).toBe(400);
    expect(r.body.errors).toEqual([
      { in: 'query', name: 'q', message: 'is required' },
      { in: 'header', name: 'X-Request-Id', message: 'is required' },
    ]); // Accept is a protocol header: OpenAPI says to ignore it as a parameter.
    expect((await call('GET', '/search?q=ab', undefined, { 'X-REQUEST-ID': 'not-a-uuid' })).headers.get('x-mock-validation')).toBe('header X-Request-Id: must match format "uuid"');
  });

  it("serves the spec's documented 422 for an invalid body, with every problem in the header", async () => {
    const r = await call('POST', '/items', { title: 'Far too long a title', priority: 'urgent' });
    expect(r.status).toBe(422);
    expect(r.body).toHaveProperty('code'); // the spec's Error schema
    const header = r.headers.get('x-mock-validation')!;
    expect(header).toContain('body /title: must NOT have more than 10 characters');
    expect(header).toContain('body /priority: must be equal to one of the allowed values');
  });

  it('requires a required body', async () => {
    const r = await call('POST', '/items');
    expect(r.status).toBe(422);
    expect(r.headers.get('x-mock-validation')).toBe('body: is required');
  });

  it('generates a 422 with the problems when the route documents none', async () => {
    const r = await call('PUT', '/items/2', { title: 7 });
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: 'Unprocessable Entity', message: "The request doesn't match the spec", errors: [{ in: 'body', path: '/title', message: 'must be string' }] });
  });

  it("doesn't parse non-JSON bodies as JSON", async () => {
    const res = await fetch(`${url}/items`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=Milk' });
    expect(res.status).toBe(201);
  });

  it('skips validation when X-Mock-Status forces a status', async () => {
    expect((await call('GET', '/items/abc', undefined, { 'X-Mock-Status': '200' })).status).toBe(200);
  });
});

describe('without --validate-requests (the default)', () => {
  it('accepts anything', async () => {
    const plain = await createMockServer({ spec: SPEC, seed: 1 });
    const plainUrl = await plain.listen(0);
    try {
      expect((await fetch(`${plainUrl}/items?limit=500`)).status).toBe(200);
      expect((await fetch(`${plainUrl}/search`)).status).toBe(200);
      expect((await fetch(`${plainUrl}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"title": 7}' })).status).toBe(201);
    } finally {
      await plain.close();
    }
  });
});

describe('checkRequest()', () => {
  it('works without a server, and follows OpenAPI 3.0 nullable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mockgen-req-'));
    const file = path.join(dir, 'spec30.yaml');
    await fs.writeFile(
      file,
      `openapi: 3.0.3
info: { title: t, version: '1' }
paths:
  /notes:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                note: { type: string, nullable: true }
      responses:
        '201': { description: created }
`,
    );
    try {
      const model = await loadOpenApi(file);
      const route = model.routes[0]!;
      const validator = new ResponseValidator(model.openapi, { direction: 'request' });
      const parts = (body: unknown) => ({ params: {}, query: new URLSearchParams(), headers: {}, body, hasBody: true });
      expect(checkRequest(route, parts({ note: null }), validator)).toEqual([]);
      expect(checkRequest(route, parts({ note: 3 }), validator)).toEqual([{ in: 'body', path: '/note', message: 'must be string,null' }]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('reading parameters the way real APIs send them (cases from the spec corpus)', () => {
  const validator = new ResponseValidator('3.1.0', { direction: 'request' });
  const route = (name: string, schema: object, required = false) =>
    ({ method: 'GET', path: '/x', pattern: /^\/x$/, paramNames: [], responses: [], parameters: [{ name, in: 'query', required, schema }] }) as const;
  const check = (r: ReturnType<typeof route>, query: string) => checkRequest(r as never, { params: {}, query: new URLSearchParams(query), headers: {} }, validator).map((i) => i.message);

  it('deepObject: Stripe-style created[gt]=1&created[lt]=9, for "an object or an integer"', () => {
    const created = route('created', { anyOf: [{ properties: { gt: { type: 'integer' }, lt: { type: 'integer' } } }, { type: 'integer' }] });
    expect(check(created, 'created[gt]=10&created[lt]=99')).toEqual([]);
    expect(check(created, 'created=1700000000')).toEqual([]);
    expect(check(created, 'created[gt]=soon')).toContain('must be integer');
  });

  it('JSON in a query parameter', () => {
    const filter = route('filter', { type: 'object', properties: { status: { type: 'string', enum: ['open'] } } });
    expect(check(filter, 'filter={"status":"open"}')).toEqual([]);
    expect(check(filter, 'filter={"status":"shut"}')).toEqual(['must be equal to one of the allowed values']);
  });

  it('"a string or an array" accepts any string, not only array items (GitHub has=)', () => {
    const has = route('has', { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string', enum: ['patch'] } }] });
    expect(check(has, 'has=anything')).toEqual([]);
    expect(check(has, 'has=patch')).toEqual([]);
  });

  it('oneOf branches that overlap (custom formats) do not reject valid values', () => {
    const country = route('country', { oneOf: [{ type: 'array', items: { type: 'string', format: 'country-code-2' } }, { type: 'array', items: { type: 'string', format: 'country-code-3' } }] });
    expect(check(country, 'country=US,DE')).toEqual([]);
  });
});
