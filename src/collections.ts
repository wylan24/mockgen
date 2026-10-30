import { generate } from './generate.js';
import { fits, mergeAllOf, typeOf } from './schema.js';
import { normalizeName } from './heuristics.js';
import type { MockRoute, Schema } from './model.js';

// List endpoints are treated as windows onto a fixed, seeded collection:
// record i always has the same data, `?page=2` shows records 10–19, and when a
// detail route exists (`/users` + `/users/{id}`), each list item is overlaid with
// the detail response for its id so the two always agree.

/** Property names that hold the records in a wrapped list response. */
const LIST_KEYS = /^(data|items|results|records|content|rows|entries|list|values|nodes|hits|objects|elements)$/;
/** Sibling names that mark an object as a page wrapper rather than a record with a nested array. */
const PAGE_HINT = /^(total|totalcount|count|page|pages|next|nextpage|cursor|nextcursor|meta|pagination|pageinfo|links|hasmore|hasnext|limit|offset)$/;

export interface ListShape {
  /** Property holding the records; undefined when the response is a bare array. */
  key?: string;
  arraySchema: Schema;
  itemSchema: Schema;
}

/** Recognize a list response: a bare array of objects, or an object wrapping one. */
export function findListShape(schema: Schema | undefined): ListShape | undefined {
  if (!schema) return undefined;
  if (typeOf(schema) === 'array') {
    return isObjectSchema(schema.items) ? { arraySchema: schema, itemSchema: schema.items } : undefined;
  }
  const props: Record<string, Schema> | undefined = (schema.allOf ? mergeAllOf(schema) : schema).properties;
  if (!props) return undefined;
  const arrays = Object.entries(props).filter(([, s]) => typeOf(s) === 'array' && isObjectSchema(s.items));
  const pick =
    arrays.find(([k]) => LIST_KEYS.test(normalizeName(k))) ??
    (arrays.length === 1 && Object.keys(props).some((k) => PAGE_HINT.test(normalizeName(k))) ? arrays[0] : undefined);
  return pick && { key: pick[0], arraySchema: pick[1], itemSchema: pick[1].items };
}

function isObjectSchema(s: Schema | undefined): s is Schema {
  return !!s && (typeOf(s) === 'object' || !!s.allOf);
}

/** The `GET /users/{id}` route for list route `GET /users`, if the spec has one. */
export function findDetailRoute(routes: MockRoute[], list: MockRoute): MockRoute | undefined {
  const prefix = `${list.path.replace(/\/$/, '')}/{`;
  return routes.find(
    (r) => r.method === 'GET' && r.path.startsWith(prefix) && r.path.endsWith('}') && !r.path.slice(prefix.length).includes('/'),
  );
}

export interface PageWindow {
  offset: number;
  limit: number;
  /** 1-based. */
  page: number;
  total: number;
}

const LIMIT_PARAMS = ['limit', 'per_page', 'perPage', 'page_size', 'pageSize', 'size', 'first'];
const OFFSET_PARAMS = ['offset', 'skip', 'start'];
const PAGE_PARAMS = ['page', 'page_number', 'pageNumber'];
const CURSOR_PARAMS = ['cursor', 'after', 'starting_after', 'page_token', 'pageToken'];

/** Work out which slice of the collection a request asks for. */
export function readPage(query: URLSearchParams, arraySchema: Schema, total: number, defaultLimit = 10): PageWindow {
  const min = Math.max(1, arraySchema.minItems ?? 1);
  const max = Math.min(1000, arraySchema.maxItems ?? 1000);
  const limit = clamp(firstInt(query, LIMIT_PARAMS) ?? defaultLimit, min, Math.max(min, max));
  const cursor = CURSOR_PARAMS.map((p) => query.get(p)).find(Boolean);
  const page = firstInt(query, PAGE_PARAMS);
  const offset = Math.max(0, (cursor ? decodeCursor(cursor) : undefined) ?? firstInt(query, OFFSET_PARAMS) ?? ((page ?? 1) - 1) * limit);
  return { offset, limit, page: page && page > 0 ? page : Math.floor(offset / limit) + 1, total };
}

export interface BuildPageInput {
  /** The list response's schema. */
  schema: Schema;
  /** Concrete request path, used to seed records and build next/prev links. */
  requestPath: string;
  query: URLSearchParams;
  origin?: string;
  seed?: number;
  shape: ListShape;
  /** Generated response body; for wrapped lists, its metadata is filled in place. */
  body: unknown;
  total: number;
  /** Name of the id property that links items to the detail route. */
  idKey?: string;
  /** Detail response for an id, used to make list items agree with `GET /x/{id}`. */
  detail?: (id: unknown) => Record<string, unknown> | undefined;
}

export function buildPage(input: BuildPageInput): { body: unknown; headers: Record<string, string> } {
  const { shape, query, total } = input;
  const win = readPage(query, shape.arraySchema, total);
  const item = shape.itemSchema.allOf ? mergeAllOf(shape.itemSchema) : shape.itemSchema;
  const props: Record<string, Schema> = item.properties ?? {};
  const idKey = input.idKey && input.idKey in props ? input.idKey : 'id' in props ? 'id' : undefined;

  const items: unknown[] = [];
  for (let i = win.offset; i < Math.min(total, win.offset + win.limit); i++) {
    const record = generate(shape.itemSchema, { seed: input.seed, key: `${input.requestPath}#${i}` }) as Record<string, unknown>;
    if (idKey) {
      const idSchema = props[idKey]!;
      const t = typeOf(idSchema);
      if (t === 'integer' || t === 'number') {
        const start = Math.max(1, Math.ceil(idSchema.minimum ?? 1));
        if (idSchema.maximum === undefined || start + i <= idSchema.maximum) record[idKey] = start + i;
      }
      const detail = input.detail?.(record[idKey]);
      if (detail) {
        for (const key of Object.keys(record)) {
          if (key in detail && fits(detail[key], props[key])) record[key] = structuredClone(detail[key]);
        }
      }
    }
    items.push(record);
  }

  const hasMore = win.offset + items.length < total;
  const headers: Record<string, string> = { 'x-total-count': String(total) };
  const links = navLinks(input, win, hasMore);
  const link = [links.next && `<${links.next}>; rel="next"`, links.prev && `<${links.prev}>; rel="prev"`].filter(Boolean).join(', ');
  if (link) headers.link = link;

  if (!shape.key) return { body: items, headers };
  const body = (input.body && typeof input.body === 'object' ? input.body : {}) as Record<string, unknown>;
  body[shape.key] = items;
  const schema = input.schema.allOf ? mergeAllOf(input.schema) : input.schema;
  fillMeta(body, schema, { ...win, count: items.length, hasMore, links }, shape.key, 0);
  return { body, headers };
}

interface MetaInfo extends PageWindow {
  count: number;
  hasMore: boolean;
  links: { next?: string; prev?: string; nextCursor?: string; prevCursor?: string };
}

/** Fill pagination fields (`total`, `page`, `next`, `meta.pagination.totalPages`, …) by name. */
function fillMeta(obj: Record<string, unknown>, schema: Schema | undefined, m: MetaInfo, listKey: string | undefined, depth: number) {
  const props: Record<string, Schema> = schema?.properties ?? {};
  const totalPages = Math.max(1, Math.ceil(m.total / m.limit));
  for (const [key, value] of Object.entries(obj)) {
    if (key === listKey) continue;
    const s = props[key];
    const n = normalizeName(key);
    const set = (v: unknown) => {
      if (fits(v, s)) obj[key] = v;
    };
    // Last page: nullable `next` becomes null, optional `next` disappears.
    const end = () => {
      if (s && (fits(null, s) || s.nullable)) obj[key] = null;
      else if (!(schema?.required ?? []).includes(key)) delete obj[key];
    };

    if (/^(total|totalcount|totalitems|totalresults|totalrecords|totalelements|totalentries|count|totalsize)$/.test(n)) set(n === 'count' && 'total' in obj ? m.count : m.total); // `count` next to `total` is the page size
    else if (/^(page|currentpage|pagenumber|pageindex)$/.test(n)) set(m.page);
    else if (/^(perpage|pagesize|limit|size|itemsperpage|pagelength)$/.test(n)) set(m.limit);
    else if (/^(totalpages|pagecount|pages|lastpage)$/.test(n)) set(totalPages);
    else if (/^(offset|skip|start)$/.test(n)) set(m.offset);
    else if (/^(hasmore|hasnext|hasnextpage|more)$/.test(n)) set(m.hasMore);
    else if (/^(hasprev|hasprevious|haspreviouspage)$/.test(n)) set(m.offset > 0);
    else if (/^(next|nextpage|nexturl|nextlink|nextcursor|endcursor|cursor)$/.test(n)) {
      if (!m.hasMore) end();
      else if (typeof value === 'number' || (s && /integer|number/.test(String(typeOf(s))))) set(m.page + 1);
      else set(/cursor/.test(n) ? m.links.nextCursor : m.links.next);
    } else if (/^(prev|previous|prevpage|previouspage|prevurl|prevlink|startcursor)$/.test(n)) {
      if (m.offset === 0) end();
      else if (typeof value === 'number' || (s && /integer|number/.test(String(typeOf(s))))) set(m.page - 1);
      else set(/cursor/.test(n) ? m.links.prevCursor : m.links.prev);
    } else if (depth < 2 && value && typeof value === 'object' && !Array.isArray(value)) {
      fillMeta(value as Record<string, unknown>, s && (s.allOf ? mergeAllOf(s) : s), m, undefined, depth + 1);
    }
  }
}

function navLinks(input: BuildPageInput, win: PageWindow, hasMore: boolean): MetaInfo['links'] {
  const link = (offset: number) => {
    const q = new URLSearchParams(input.query);
    for (const p of CURSOR_PARAMS) q.delete(p);
    const usesOffset = OFFSET_PARAMS.some((p) => q.has(p));
    if (usesOffset) for (const p of OFFSET_PARAMS) q.has(p) && q.set(p, String(offset));
    else q.set(PAGE_PARAMS.find((p) => q.has(p)) ?? 'page', String(Math.floor(offset / win.limit) + 1));
    if (!LIMIT_PARAMS.some((p) => q.has(p))) q.set('limit', String(win.limit));
    return `${input.origin ?? ''}${input.requestPath}?${q}`;
  };
  const prevOffset = Math.max(0, win.offset - win.limit);
  return {
    next: hasMore ? link(win.offset + win.limit) : undefined,
    prev: win.offset > 0 ? link(prevOffset) : undefined,
    nextCursor: hasMore ? encodeCursor(win.offset + win.limit) : undefined,
    prevCursor: win.offset > 0 ? encodeCursor(prevOffset) : undefined,
  };
}

/** Opaque-looking cursors that are really offsets, so any cursor we hand out works. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`).toString('base64url');
}

function decodeCursor(cursor: string): number | undefined {
  const m = /^o:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString());
  return m ? Number(m[1]) : undefined;
}

function firstInt(query: URLSearchParams, names: string[]): number | undefined {
  for (const name of names) {
    const v = query.get(name);
    if (v !== null && /^-?\d+$/.test(v)) return Number(v);
  }
  return undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
