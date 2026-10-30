import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { beforeAll, describe, expect, it } from 'vitest';
import { encodeCursor, findListShape, readPage } from '../src/collections.js';
import { loadOpenApi, loadSource, respond, type MockModel } from '../src/index.js';

const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);

const obj = { type: 'object', properties: { id: { type: 'integer' } } };

describe('findListShape', () => {
  it('recognizes bare arrays of objects', () => {
    expect(findListShape({ type: 'array', items: obj })?.key).toBeUndefined();
    expect(findListShape({ type: 'array', items: { type: 'string' } })).toBeUndefined();
  });

  it('recognizes wrapped lists by key name or page-like siblings', () => {
    expect(findListShape({ type: 'object', properties: { data: { type: 'array', items: obj } } })?.key).toBe('data');
    expect(findListShape({ type: 'object', properties: { users: { type: 'array', items: obj }, total: { type: 'integer' } } })?.key).toBe('users');
  });

  it('does not treat a record with a nested array as a list', () => {
    expect(findListShape({ type: 'object', properties: { name: { type: 'string' }, posts: { type: 'array', items: obj } } })).toBeUndefined();
  });
});

describe('readPage', () => {
  const arr = { type: 'array', items: obj };
  const q = (s: string) => new URLSearchParams(s);
  it.each([
    ['', { offset: 0, limit: 10, page: 1 }],
    ['page=3&limit=5', { offset: 10, limit: 5, page: 3 }],
    ['per_page=20&page=2', { offset: 20, limit: 20, page: 2 }],
    ['offset=7&limit=7', { offset: 7, limit: 7, page: 2 }],
    [`cursor=${encodeCursor(30)}`, { offset: 30, limit: 10, page: 4 }],
    ['page=0', { offset: 0, limit: 10, page: 1 }],
  ])('%s', (query, expected) => {
    expect(readPage(q(query), arr, 50)).toMatchObject(expected);
  });

  it('clamps limit to the schema minItems/maxItems', () => {
    expect(readPage(q('limit=500'), { ...arr, maxItems: 25 }, 50).limit).toBe(25);
    expect(readPage(q('limit=1'), { ...arr, minItems: 3 }, 50).limit).toBe(3);
  });
});

describe('list endpoints', () => {
  let petstore: MockModel;
  beforeAll(async () => {
    petstore = await loadSource('examples/petstore.yaml');
  });
  const get = (path: string, query = '', model = petstore) => respond(model, { method: 'GET', path, query, seed: 1, origin: 'http://mock.test' });

  it('pages through a stable collection with sequential ids', () => {
    expect(get('/pets').body).toHaveLength(10);
    expect((get('/pets', 'page=2&limit=5').body as any[]).map((p) => p.id)).toEqual([6, 7, 8, 9, 10]);
    expect(get('/pets', 'page=2&limit=5').body).toEqual((get('/pets', 'limit=10').body as any[]).slice(5));
  });

  it('returns a short last page and an empty page past the end', () => {
    expect(get('/pets', 'offset=45').body).toHaveLength(5);
    expect(get('/pets', 'page=99').body).toEqual([]);
  });

  it('sends X-Total-Count and Link headers', () => {
    const { headers } = get('/pets', 'page=2&limit=5');
    expect(headers['x-total-count']).toBe('50');
    expect(headers.link).toBe('<http://mock.test/pets?page=3&limit=5>; rel="next", <http://mock.test/pets?page=1&limit=5>; rel="prev"');
    expect(get('/pets', 'page=10&limit=5').headers.link).not.toContain('rel="next"');
  });

  it('honors the records option', () => {
    const r = respond(petstore, { method: 'GET', path: '/pets', query: 'limit=100', seed: 1, records: 7 });
    expect(r.body).toHaveLength(7);
    expect(r.headers['x-total-count']).toBe('7');
  });

  it('list items agree with the detail route', () => {
    const users = (get('/users', 'page=3&limit=4').body as any).data as any[];
    for (const user of users) {
      const detail = get(`/users/${user.id}`).body as any;
      expect(user).toEqual(detail);
    }
  });

  it('fills wrapper metadata', () => {
    const body = get('/users', 'page=3&limit=4').body as any;
    expect(body).toMatchObject({ page: 3, total: 50 });
    expect(body.data.map((u: any) => u.id)).toEqual([9, 10, 11, 12]);
  });

  it('keeps paged responses valid against the spec', () => {
    for (const route of petstore.routes.filter((r) => r.method === 'GET' && !r.path.endsWith('}'))) {
      const validate = ajv.compile(route.responses[0]!.schema!);
      for (const query of ['', 'page=2&limit=3', 'page=99']) {
        const { body } = get(route.path, query);
        expect(validate(body), `${route.path}?${query}: ${ajv.errorsText(validate.errors)}`).toBe(true);
      }
    }
  });

  it('works for sample folders too', async () => {
    const samples = await loadSource('examples/samples');
    const list = get('/users', 'limit=3', samples).body as any[];
    expect(list.map((u) => u.id)).toEqual([1, 2, 3]);
    expect(list[1]).toEqual(expect.objectContaining({ name: (get('/users/2', '', samples).body as any).name }));
  });
});

describe('cursor-paginated wrappers', () => {
  let model: MockModel;
  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mockgen-'));
    const file = path.join(dir, 'spec.json');
    const item = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' }, title: { type: 'string' } } };
    await fs.writeFile(
      file,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'cursor', version: '1' },
        paths: {
          '/posts': {
            get: {
              responses: {
                200: {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['items', 'meta'],
                        properties: {
                          items: { type: 'array', items: item },
                          meta: {
                            type: 'object',
                            properties: {
                              nextCursor: { type: ['string', 'null'] },
                              hasMore: { type: 'boolean' },
                              totalCount: { type: 'integer' },
                              links: { type: 'object', properties: { next: { type: ['string', 'null'], format: 'uri' } } },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '/posts/{postId}': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: item } } } } } },
        },
      }),
    );
    model = await loadOpenApi(file);
  });

  it('follows nextCursor to the end of the collection', () => {
    const seen: string[] = [];
    let query = 'limit=20';
    for (let i = 0; i < 10; i++) {
      const body = respond(model, { method: 'GET', path: '/posts', query, seed: 1, origin: 'http://mock.test' }).body as any;
      seen.push(...body.items.map((p: any) => p.id));
      expect(body.meta.totalCount).toBe(50);
      if (!body.meta.hasMore) {
        expect(body.meta.nextCursor).toBeNull();
        expect(body.meta.links.next).toBeNull();
        break;
      }
      expect(body.meta.links.next).toMatch(/^http:\/\/mock\.test\/posts\?/);
      query = `limit=20&cursor=${body.meta.nextCursor}`;
    }
    expect(seen).toHaveLength(50);
    expect(new Set(seen).size).toBe(50);
  });

  it('string ids still link list items to detail', () => {
    const first = (respond(model, { method: 'GET', path: '/posts', seed: 1 }).body as any).items[0];
    expect(respond(model, { method: 'GET', path: `/posts/${first.id}`, seed: 1 }).body).toEqual(first);
  });
});
