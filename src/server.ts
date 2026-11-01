import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildPage, findDetailRoute, findListShape, generatedIds, listIdKey } from './collections.js';
import { assertLocale, generate } from './generate.js';
import type { MockModel, MockResponse, MockRoute, Schema } from './model.js';
import { normalizeName } from './heuristics.js';
import { fits, mergeAllOf, typeOf } from './schema.js';
import type { RouteContext, RouteOverride } from './config.js';
import { checkRequest, describeIssue, type RequestIssue } from './requests.js';
import { type CollectionState, MockState } from './state.js';
import { ResponseValidator } from './validate.js';

export interface MockServerOptions {
  model: MockModel;
  /** Seed for generated data; same seed → same responses. Default 1. */
  seed?: number;
  /** Delay every response by this many milliseconds. Overridden per request by `X-Mock-Delay`. */
  delay?: number;
  /** Size of every list endpoint's collection, paged through with `?page=`/`?limit=`. Default 50. */
  records?: number;
  /** Faker locale for names, addresses and text, e.g. `de` or `pt_BR`. Default `en`. */
  locale?: string;
  /** Called once per request with a one-line summary. */
  log?: (line: string) => void;
  /**
   * Remember changes: POST creates records, PUT/PATCH change them, DELETE removes
   * them, and lists and detail routes reflect that. Default false: every response
   * depends only on the spec, the seed and the request.
   */
  stateful?: boolean;
  /**
   * Check requests against the spec: path, query and header parameters and the JSON
   * body. Invalid requests get the spec's 400/422 response (or a generated one
   * listing the problems) and an `X-Mock-Validation` header. Default false.
   */
  validateRequests?: boolean;
  /** Per-route overrides, keyed by `METHOD /path` as in the spec (see `mock.config.ts`). */
  overrides?: Record<string, RouteOverride>;
}

export interface MockServer {
  server: http.Server;
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
  /** Swap the model in place, e.g. after the spec changed on disk. Resets stateful changes. */
  setModel(model: MockModel): void;
  /** Stateful mode: forget every change, back to the generated data. */
  reset(): void;
  /** Replace the route overrides, e.g. after the config file changed. */
  setOverrides(overrides: Record<string, RouteOverride> | undefined): void;
}

/** Largest request body read in stateful mode. */
const MAX_BODY_BYTES = 1024 * 1024;
/** Stateful mode: `POST` here forgets every change. */
export const RESET_PATH = '/__mockgen/reset';

export interface MockResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  /** A route override's delay, in milliseconds. */
  delay?: number;
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
};

export function createMockServer(options: MockServerOptions): MockServer {
  if (options.locale) assertLocale(options.locale);
  let model = options.model;
  const seed = options.seed ?? 1;
  const state = options.stateful ? new MockState() : undefined;
  let overrides = options.overrides;
  let requestValidator = options.validateRequests ? new ResponseValidator(model.openapi, { direction: 'request' }) : undefined;

  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toUpperCase();
    const forcedStatus = header(req, 'x-mock-status') ?? url.searchParams.get('__status') ?? undefined;

    // Bodies only matter in stateful mode and for request validation; otherwise drain them.
    let body: { value?: unknown; present?: boolean; error?: MockResult } = {};
    if ((state || requestValidator) && (method === 'POST' || method === 'PUT' || method === 'PATCH')) body = await readJsonBody(req);
    else req.resume();

    const input: RespondInput = {
      method,
      path: url.pathname,
      seed,
      locale: options.locale,
      status: forcedStatus,
      query: url.searchParams,
      origin: req.headers.host ? `http://${req.headers.host}` : undefined,
      records: options.records,
      state,
      body: body.value,
      overrides,
    };

    let result: MockResult | undefined;
    // X-Mock-Status is a deliberate simulation, so it skips validation.
    if (!body.error && requestValidator && forcedStatus === undefined) {
      const { route, params } = findRoute(model, method, url.pathname);
      if (route) {
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v]));
        const issues = checkRequest(route, { params, query: url.searchParams, headers, body: body.value, hasBody: body.present }, requestValidator);
        if (issues.length) result = invalidRequest(model, route, issues, input);
      }
    }

    if (result) {
      // Already answered: the request didn't match the spec.
    } else if (body.error) {
      result = body.error;
    } else if (state && method === 'POST' && url.pathname === RESET_PATH) {
      state.reset();
      result = { status: 204, body: undefined, headers: {} };
    } else if (method === 'OPTIONS' && !findRoute(model, 'OPTIONS', url.pathname).route) {
      result = { status: 204, body: undefined, headers: {} };
    } else {
      result = respond(model, input);
    }

    const delay = Number(header(req, 'x-mock-delay') ?? url.searchParams.get('__delay') ?? result.delay ?? options.delay ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    const hasBody = result.body !== undefined && method !== 'HEAD' && result.status !== 204 && result.status !== 304;
    res.writeHead(result.status, {
      ...CORS_HEADERS,
      ...(hasBody ? { 'content-type': 'application/json; charset=utf-8' } : {}),
      ...result.headers,
    });
    res.end(hasBody ? JSON.stringify(result.body, null, 2) : undefined);

    options.log?.(`${method} ${url.pathname}${url.search} → ${result.status} ${Math.round(performance.now() - started)}ms`);
  });

  return {
    server,
    listen(port = 4010, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const addr = server.address() as AddressInfo;
          resolve(`http://${host.includes(':') ? `[${host}]` : host}:${addr.port}`);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
    setModel(next) {
      model = next;
      state?.reset();
      if (requestValidator) requestValidator = new ResponseValidator(next.openapi, { direction: 'request' });
    },
    reset() {
      state?.reset();
    },
    setOverrides(next) {
      overrides = next;
    },
  };
}

/**
 * Read a request body. `value` is the parsed JSON, undefined for an empty or non-JSON
 * body; `present` says whether there was a body at all; `error` is a 400 or 413 to send.
 * Only JSON (or an unlabelled body) is parsed, so a form upload isn't "invalid JSON".
 */
async function readJsonBody(req: http.IncomingMessage): Promise<{ value?: unknown; present?: boolean; error?: MockResult }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return { error: errorResult(413, `Request body is larger than ${MAX_BODY_BYTES} bytes`) };
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  const type = req.headers['content-type'];
  if (type && !/json/i.test(type)) return { present: true };
  try {
    return { value: JSON.parse(text), present: true };
  } catch {
    return { error: errorResult(400, 'Request body is not valid JSON') };
  }
}

export interface RespondInput {
  method: string;
  path: string;
  seed?: number;
  /** Force a status code, e.g. from `X-Mock-Status`. */
  status?: string | number;
  /** Query string; drives pagination on list endpoints. */
  query?: URLSearchParams | string;
  /** `http://host:port`, used to build absolute next/prev links. */
  origin?: string;
  /** Collection size for list endpoints. Default 50. */
  records?: number;
  /** Faker locale, e.g. `de`. Default `en`. */
  locale?: string;
  /** Stateful mode: the changes so far. `respond()` records this request's changes in it. */
  state?: MockState;
  /** Stateful mode: the parsed JSON request body. */
  body?: unknown;
  /** Per-route overrides, keyed by `METHOD /path` as in the spec. */
  overrides?: Record<string, RouteOverride>;
}

/** Produce the mock response for one request. Pure apart from the generator's seed, and `state` if given. */
export function respond(model: MockModel, input: RespondInput): MockResult {
  if (!input.overrides) return respondFromSpec(model, input);
  const { route, params } = findRoute(model, input.method, input.path);
  const override = route && input.overrides[`${route.method} ${route.path}`];
  if (!override) return respondFromSpec(model, input);

  // A per-request X-Mock-Status wins: the override's status, body and merge are for the normal response.
  const requestForced = input.status !== undefined;
  const result = respondFromSpec(model, !requestForced && override.status !== undefined && override.body === undefined ? { ...input, status: override.status } : input);
  if (!requestForced) {
    if (override.body !== undefined) {
      result.body =
        typeof override.body === 'function'
          ? override.body({ method: input.method, path: input.path, params, query: new URLSearchParams(input.query ?? ''), body: input.body, seed: input.seed ?? 1 })
          : structuredClone(override.body);
      if (override.status !== undefined) result.status = override.status;
    }
    if (override.merge && isRecord(result.body)) deepMerge(result.body, override.merge);
  }
  if (override.headers) result.headers = { ...result.headers, ...override.headers };
  if (override.delay !== undefined) result.delay = override.delay;
  return result;
}

/** Copy `source` into `target`, merging nested objects and replacing everything else. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const [key, value] of Object.entries(source)) {
    if (isRecord(value) && isRecord(target[key])) deepMerge(target[key], value);
    else target[key] = structuredClone(value);
  }
}

function respondFromSpec(model: MockModel, input: RespondInput): MockResult {
  const { route, params, pathExists } = findRoute(model, input.method, input.path);
  if (!route) {
    return pathExists
      ? errorResult(405, `Method ${input.method} is not defined for ${input.path}`)
      : errorResult(404, `No route in the spec matches ${input.method} ${input.path}`);
  }

  const forced = input.status !== undefined ? Number(input.status) : undefined;
  if (forced !== undefined && !(forced >= 100 && forced <= 599)) {
    return errorResult(400, `X-Mock-Status must be an HTTP status code, got "${input.status}"`);
  }

  // A forced status is only a simulation: it never changes state.
  if (input.state && forced === undefined) {
    const result = respondStateful(model, { ...input, state: input.state }, route, params);
    if (result) return result;
  }

  const response = pickResponse(route.responses, forced);
  const status = forced ?? response?.status ?? 200;
  if (!response || (forced !== undefined && response.status !== forced && !response.isDefault)) {
    // The spec doesn't describe this status; still honor it so error paths can be tested.
    return status >= 400 ? errorResult(status, http.STATUS_CODES[status] ?? 'Error') : { status, body: undefined, headers: {} };
  }

  let body: unknown;
  if (response.hasExample) body = structuredClone(response.example);
  else if (response.schema) body = generate(response.schema, { seed: input.seed, locale: input.locale, key: `${route.method} ${input.path} ${status}` });

  let headers: Record<string, string> = {};
  // List endpoints (not `/users/{id}`) page through a stable collection.
  const shape = route.method === 'GET' && !response.hasExample && status < 300 && !route.path.endsWith('}') ? findListShape(response.schema) : undefined;
  if (shape) {
    const requestPath = input.path.replace(/(.)\/$/, '$1');
    const detailRoute = findDetailRoute(model.routes, route);
    const detailResponse = detailRoute && pickResponse(detailRoute.responses);
    const linked = !!detailResponse?.schema && !detailResponse.hasExample;
    ({ body, headers } = buildPage({
      schema: response.schema!,
      requestPath,
      query: new URLSearchParams(input.query ?? ''),
      origin: input.origin,
      seed: input.seed,
      locale: input.locale,
      state: input.state?.collection(requestPath),
      shape,
      body,
      total: input.records ?? 50,
      idKey: detailRoute?.paramNames.at(-1),
      detailSchema: linked ? detailResponse.schema : undefined,
      detail: linked
        ? (id) => {
            // Overrides apply here too, so a `merge` on the detail route shows up in the list.
            const r = respond(model, { method: 'GET', path: `${requestPath}/${encodeURIComponent(String(id))}`, seed: input.seed, locale: input.locale, overrides: input.overrides });
            return r.status < 300 && isRecord(r.body) ? r.body : undefined;
          }
        : undefined,
    }));
  }

  if (isRecord(body) && response.schema) applyPathParams(body, response.schema, route, params);
  return { status, body, headers };
}

// Stateful mode ---------------------------------------------------------------
//
// A collection is a list path (`/users`) and its detail routes (`/users/{id}`).
// POST to the list path creates a record; PUT/PATCH/DELETE/GET on a detail path
// act on one. Records are stored whole, in the shape of the detail response (or
// the list item), and every response is projected from them onto its own schema,
// so responses stay valid. Request fields that don't fit the schema are ignored.

interface Collection {
  /** Concrete path, e.g. `/users` or `/users/3/posts`. */
  path: string;
  state: CollectionState;
  /** Shape of one stored record: the detail response, else the list item. */
  recordSchema: Schema;
  idKey?: string;
  /** Ids of the generated records, when a list route makes them enumerable. */
  ids?: unknown[];
  detailRoute?: MockRoute;
}

type StatefulInput = RespondInput & { state: MockState };

/** Handle a request in stateful mode; undefined means respond as usual. */
function respondStateful(model: MockModel, input: StatefulInput, route: MockRoute, params: Record<string, string>): MockResult | undefined {
  const path = input.path.replace(/(.)\/$/, '$1');
  if (!route.path.endsWith('}')) return route.method === 'POST' ? create(model, input, route, path) : undefined;
  if (!['GET', 'PUT', 'PATCH', 'DELETE'].includes(route.method)) return undefined;

  const template = route.path.slice(0, route.path.lastIndexOf('/'));
  const collection = collectionFor(model, input, template, path.slice(0, path.lastIndexOf('/')) || '/');
  if (!collection) return undefined;
  const { state } = collection;
  const id = params[route.paramNames.at(-1)!]!;
  const created = state.created.get(id);
  const exists = !!created || (!state.deleted.has(id) && (!collection.ids || collection.ids.some((x) => String(x) === id)));
  if (!exists) return respond(model, { ...input, state: undefined, body: undefined, status: 404 });
  const stored = created ?? state.updated.get(id);

  if (route.method === 'GET') return stored ? success(route, stored, input) : undefined;
  if (route.method === 'DELETE') {
    const record = stored ?? generatedRecord(model, input, collection, path);
    if (created) state.created.delete(id);
    else {
      state.deleted.add(id);
      state.updated.delete(id);
    }
    return success(route, record, input);
  }
  // PUT and PATCH both merge the body's fields into the record.
  if (input.body !== undefined && !isRecord(input.body)) return errorResult(400, 'Request body must be a JSON object');
  const next = structuredClone(stored ?? generatedRecord(model, input, collection, path));
  mergeBody(next, input.body, collection);
  (created ? state.created : state.updated).set(id, next);
  return success(route, next, input);
}

function create(model: MockModel, input: StatefulInput, route: MockRoute, path: string): MockResult | undefined {
  const collection = collectionFor(model, input, route.path, path);
  if (!collection) return undefined;
  if (input.body !== undefined && !isRecord(input.body)) return errorResult(400, 'Request body must be a JSON object');
  const { state, recordSchema, idKey } = collection;
  const n = state.creates;
  const record = generate(recordSchema, { seed: input.seed, locale: input.locale, key: `POST ${path} #${n}` });
  if (!isRecord(record)) return undefined;
  state.creates++;
  mergeBody(record, input.body, collection);
  const id = idKey ? newId(collection, record[idKey], n, input) : `#${n}`;
  if (idKey) record[idKey] = id;
  state.created.set(String(id), record);

  const result = success(route, record, input);
  if (idKey && collection.detailRoute && result.status < 300) result.headers.location = `${path}/${encodeURIComponent(String(id))}`;
  return result;
}

/** The collection a request belongs to, from its list path template (`/users/{id}/posts`) and concrete path. */
function collectionFor(model: MockModel, input: StatefulInput, template: string, path: string): Collection | undefined {
  const listRoute = model.routes.find((r) => r.method === 'GET' && r.path === template);
  const listResponse = listRoute && pickResponse(listRoute.responses);
  const shape = listResponse && !listResponse.hasExample ? findListShape(listResponse.schema) : undefined;
  const detailRoute = findDetailRoute(model.routes, { path: template } as MockRoute);
  const detailResponse = detailRoute && pickResponse(detailRoute.responses);
  const recordSchema = (detailResponse && !detailResponse.hasExample ? detailResponse.schema : undefined) ?? shape?.itemSchema;
  if (!recordSchema || !(typeOf(recordSchema) === 'object' || recordSchema.allOf)) return undefined;

  const state = input.state.collection(path);
  const idKey = listIdKey(shape?.itemSchema ?? recordSchema, detailRoute?.paramNames.at(-1));
  const ids = shape && idKey ? generatedIds(state, shape.itemSchema, idKey, input.records ?? 50, path, input.seed, input.locale) : undefined;
  return { path, state, recordSchema, idKey, ids, detailRoute };
}

/** The next free id: one past the largest for numeric ids, else a generated one that isn't taken. */
function newId(collection: Collection, generated: unknown, n: number, input: StatefulInput): unknown {
  const idSchema = propsOf(collection.recordSchema)[collection.idKey!];
  if (!idSchema) return generated;
  const created = [...collection.state.created.values()].map((r) => r[collection.idKey!]);
  const t = typeOf(idSchema);
  if (t === 'integer' || t === 'number') {
    const min = Math.max(1, Math.ceil(idSchema?.minimum ?? 1));
    // Without a list route the generated ids aren't known; assume the usual 1…records.
    const taken = [...(collection.ids ?? [min + (input.records ?? 50) - 1]), ...created].filter((x): x is number => typeof x === 'number');
    return taken.length ? Math.max(...taken) + 1 : min;
  }
  const taken = new Set([...(collection.ids ?? []), ...created].map(String));
  let id = generated;
  for (let k = 1; taken.has(String(id)) && k < 100; k++) id = generate(idSchema, { seed: input.seed, locale: input.locale, key: `POST ${collection.path} #${n}.id${k}` });
  return id;
}

/** Copy the body's fields onto the record, skipping the id, read-only fields, and fields that don't fit the schema. */
function mergeBody(record: Record<string, unknown>, body: unknown, collection: Collection) {
  if (!isRecord(body)) return;
  const props = propsOf(collection.recordSchema);
  let renamed = false;
  for (const [key, value] of Object.entries(body)) {
    const s = props[key];
    if (key === collection.idKey || !s || s.readOnly) continue;
    if (fits(value, s)) {
      record[key] = structuredClone(value);
      if (PERSON_NAME.test(normalizeName(key))) renamed = true;
    }
  }
  if (renamed) matchIdentity(record, body, props);
}

const PERSON_NAME = /^(firstname|givenname|lastname|surname|familyname|name|fullname|displayname)$/;

/**
 * After a person's name changed, keep their email and username matching it, as
 * generated records do: Ada Lovelace becomes ada.lovelace@<the same domain>. Fields
 * the body set itself are left alone, and so is anything the new value wouldn't fit.
 */
function matchIdentity(record: Record<string, unknown>, body: Record<string, unknown>, props: Record<string, Schema>) {
  const keyOf = (re: RegExp) => Object.keys(record).find((k) => re.test(normalizeName(k)));
  const text = (k: string | undefined) => (k && typeof record[k] === 'string' ? (record[k] as string) : '');
  let first = text(keyOf(/^(firstname|givenname)$/));
  let last = text(keyOf(/^(lastname|surname|familyname)$/));
  if (!first || !last) {
    const [head = '', ...tail] = text(keyOf(/^(name|fullname|displayname)$/)).trim().split(/\s+/);
    first ||= head;
    last ||= tail.join(' ');
  }
  // ASCII only: "Zoë Müller" becomes zoe.muller.
  const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  const local = [slug(first), slug(last)].filter(Boolean).join('.');
  if (!local) return;
  for (const [key, current] of Object.entries(record)) {
    if (key in body || typeof current !== 'string') continue;
    const n = normalizeName(key);
    const value = /email/.test(n) && current.includes('@') ? `${local}@${current.split('@').pop()}` : /^(username|login|handle)$/.test(n) ? local : undefined;
    if (value !== undefined && fits(value, props[key])) record[key] = value;
  }
}

/** The record as it is before any change: the detail route's response, or generated from the record schema. */
function generatedRecord(model: MockModel, input: StatefulInput, collection: Collection, path: string): Record<string, unknown> {
  if (collection.detailRoute) {
    const r = respond(model, { ...input, method: 'GET', path, state: undefined, body: undefined, status: undefined });
    if (isRecord(r.body)) return r.body;
  }
  const record = generate(collection.recordSchema, { seed: input.seed, locale: input.locale, key: `GET ${path} 200` });
  return isRecord(record) ? record : {};
}

/** The route's success response, with the record projected onto its schema. */
function success(route: MockRoute, record: Record<string, unknown>, input: RespondInput): MockResult {
  const response = pickResponse(route.responses);
  const status = response && response.status < 300 ? response.status : route.method === 'POST' ? 201 : 200;
  if (!response?.schema || status === 204) return { status, body: undefined, headers: {} };
  const body = generate(response.schema, { seed: input.seed, locale: input.locale, key: `${route.method} ${input.path} ${status}` });
  if (!isRecord(body)) return { status, body, headers: {} };
  const props = propsOf(response.schema);
  for (const [key, value] of Object.entries(record)) if (props[key] && fits(value, props[key])) body[key] = structuredClone(value);
  return { status, body, headers: {} };
}

function propsOf(schema: Schema | undefined): Record<string, Schema> {
  return (schema?.allOf ? mergeAllOf(schema) : schema)?.properties ?? {};
}

function findRoute(model: MockModel, method: string, rawPath: string) {
  let p = rawPath;
  if (model.basePath && (p === model.basePath || p.startsWith(`${model.basePath}/`))) {
    p = p.slice(model.basePath.length) || '/';
  }
  let pathExists = false;
  for (const route of model.routes) {
    const m = route.pattern.exec(p);
    if (!m) continue;
    pathExists = true;
    if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1]!)));
    return { route, params, pathExists };
  }
  return { route: undefined, params: {}, pathExists };
}

function pickResponse(responses: MockResponse[], forced?: number): MockResponse | undefined {
  if (forced !== undefined) {
    return responses.find((r) => r.status === forced && !r.isDefault) ?? responses.find((r) => r.isDefault);
  }
  const explicit = responses.filter((r) => !r.isDefault).sort((a, b) => a.status - b.status);
  return explicit.find((r) => r.status >= 200 && r.status < 300) ?? responses.find((r) => r.isDefault) ?? explicit[0];
}

/** `GET /users/42` returns a user whose `id` is 42 — when 42 is a valid `id` for the schema. */
function applyPathParams(body: Record<string, unknown>, schema: Schema, route: MockRoute, params: Record<string, string>) {
  const props: Record<string, Schema> = (schema.allOf ? mergeAllOf(schema) : schema).properties ?? {};
  const last = route.paramNames.at(-1);
  for (const [name, raw] of Object.entries(params)) {
    const key = name in body ? name : name === last && 'id' in body ? 'id' : undefined;
    if (!key) continue;
    const value = raw.trim() !== '' && typeof body[key] === 'number' ? Number(raw) : raw;
    if (fits(value, props[key])) body[key] = value;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The answer to a request that doesn't match the spec: 422 for body problems, 400 for
 * parameters. If the route documents 400 or 422, that response is served, so clients
 * see the API's real error shape; otherwise a generated one lists each problem. Either
 * way, `X-Mock-Validation` summarizes what failed.
 */
function invalidRequest(model: MockModel, route: MockRoute, issues: RequestIssue[], input: RespondInput): MockResult {
  const preferred = issues.some((i) => i.in === 'body') ? 422 : 400;
  const documented = [preferred, preferred === 422 ? 400 : 422].find((s) => route.responses.some((r) => r.status === s && !r.isDefault));
  const result: MockResult = documented
    ? respond(model, { ...input, status: documented, state: undefined, body: undefined })
    : { status: preferred, body: { error: http.STATUS_CODES[preferred], message: "The request doesn't match the spec", errors: issues }, headers: {} };
  // Header values must be printable ASCII.
  result.headers = { ...result.headers, 'x-mock-validation': issues.map(describeIssue).join('; ').replace(/[^\x20-\x7e]/g, '?').slice(0, 2000) };
  return result;
}

function errorResult(status: number, message: string): MockResult {
  return { status, body: { error: http.STATUS_CODES[status] ?? 'Error', message }, headers: {} };
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
