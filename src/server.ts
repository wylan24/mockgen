import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildPage, findDetailRoute, findListShape } from './collections.js';
import { assertLocale, generate } from './generate.js';
import type { MockModel, MockResponse, MockRoute, Schema } from './model.js';
import { fits, mergeAllOf } from './schema.js';

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
}

export interface MockServer {
  server: http.Server;
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
  /** Swap the model in place, e.g. after the spec changed on disk. */
  setModel(model: MockModel): void;
}

export interface MockResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
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

  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toUpperCase();
    req.resume(); // Request bodies are not used yet; drain them.

    let result: MockResult;
    if (method === 'OPTIONS' && !findRoute(model, 'OPTIONS', url.pathname).route) {
      result = { status: 204, body: undefined, headers: {} };
    } else {
      result = respond(model, {
        method,
        path: url.pathname,
        seed,
        locale: options.locale,
        status: header(req, 'x-mock-status') ?? url.searchParams.get('__status') ?? undefined,
        query: url.searchParams,
        origin: req.headers.host ? `http://${req.headers.host}` : undefined,
        records: options.records,
      });
    }

    const delay = Number(header(req, 'x-mock-delay') ?? url.searchParams.get('__delay') ?? options.delay ?? 0);
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
    },
  };
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
}

/** Produce the mock response for one request. Pure apart from the generator's seed. */
export function respond(model: MockModel, input: RespondInput): MockResult {
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
      shape,
      body,
      total: input.records ?? 50,
      idKey: detailRoute?.paramNames.at(-1),
      detailSchema: linked ? detailResponse.schema : undefined,
      detail: linked
        ? (id) => {
            const r = respond(model, { method: 'GET', path: `${requestPath}/${encodeURIComponent(String(id))}`, seed: input.seed, locale: input.locale });
            return r.status < 300 && isRecord(r.body) ? r.body : undefined;
          }
        : undefined,
    }));
  }

  if (isRecord(body) && response.schema) applyPathParams(body, response.schema, route, params);
  return { status, body, headers };
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

function errorResult(status: number, message: string): MockResult {
  return { status, body: { error: http.STATUS_CODES[status] ?? 'Error', message }, headers: {} };
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
