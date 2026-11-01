// mock.config.ts: defaults for the CLI options, and per-route overrides for when
// generated data isn't what you need. TypeScript configs run through Node's own
// type stripping (Node 22.18+), so there's no build step; `import type` keeps them
// working even when mockgen isn't installed (plain `npx`).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MockModel } from './model.js';
import { ResponseValidator } from './validate.js';

/** What a route override's `body` function receives. */
export interface RouteContext {
  method: string;
  /** The concrete request path, e.g. `/users/42`. */
  path: string;
  /** Path parameters by name, e.g. `{ id: '42' }`. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** The parsed JSON request body, in stateful mode. */
  body: unknown;
  seed: number;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface RouteOverride {
  /** Respond with this status. The spec's response for it is generated unless `body` is set. */
  status?: number;
  /** Delay this route's responses, in milliseconds. */
  delay?: number;
  /** Extra response headers. */
  headers?: Record<string, string>;
  /** Respond with this body instead of generated data, or compute one per request. */
  body?: JsonValue | ((ctx: RouteContext) => unknown);
  /** Fields to deep-merge into the response body, e.g. `{ role: 'admin' }`. */
  merge?: Record<string, unknown>;
}

export interface MockConfig {
  seed?: number;
  records?: number;
  locale?: string;
  delay?: number;
  stateful?: boolean;
  /** Check requests against the spec; invalid ones get a 400/422. */
  validateRequests?: boolean;
  port?: number;
  host?: string;
  /** Per-route overrides, keyed by `METHOD /path` exactly as in the spec, e.g. `GET /users/{id}`. */
  routes?: Record<string, RouteOverride>;
}

/** Optional helper for type checking: `export default defineConfig({ ... })`. */
export function defineConfig(config: MockConfig): MockConfig {
  return config;
}

export const CONFIG_FILES = ['mock.config.ts', 'mock.config.mts', 'mock.config.js', 'mock.config.mjs', 'mock.config.json'];

/** The config file in `dir`, if there is one. */
export function findConfig(dir = process.cwd()): string | undefined {
  return CONFIG_FILES.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
}

export class ConfigError extends Error {
  constructor(file: string, message: string) {
    super(`${path.relative(process.cwd(), file) || file}: ${message}`);
    this.name = 'ConfigError';
  }
}

/** Load and check a config file. Re-imports on every call, so hot reload sees edits. */
export async function loadConfig(file: string): Promise<MockConfig> {
  let raw: unknown;
  try {
    if (file.endsWith('.json')) raw = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    else raw = ((await import(`${pathToFileURL(path.resolve(file)).href}?t=${Date.now()}`)) as { default?: unknown }).default;
  } catch (err) {
    throw new ConfigError(file, (err as Error).message);
  }
  return checkConfig(raw, file);
}

const NUMBER_KEYS = ['seed', 'records', 'delay', 'port'] as const;
const OVERRIDE_KEYS = new Set(['status', 'delay', 'headers', 'body', 'merge']);

function checkConfig(raw: unknown, file: string): MockConfig {
  if (!isObject(raw)) throw new ConfigError(file, 'must export a config object (`export default { ... }`)');
  const known = new Set<string>([...NUMBER_KEYS, 'locale', 'stateful', 'validateRequests', 'host', 'routes']);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new ConfigError(file, `unknown option "${key}". Options: ${[...known].join(', ')}`);
  for (const key of NUMBER_KEYS) {
    if (raw[key] !== undefined && !(Number.isInteger(raw[key]) && (raw[key] as number) >= 0)) throw new ConfigError(file, `"${key}" must be a whole number`);
  }
  for (const key of ['locale', 'host'] as const) if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new ConfigError(file, `"${key}" must be a string`);
  for (const key of ['stateful', 'validateRequests'] as const) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new ConfigError(file, `"${key}" must be true or false`);
  if (raw.routes !== undefined) {
    if (!isObject(raw.routes)) throw new ConfigError(file, '"routes" must be an object keyed by "METHOD /path"');
    for (const [key, ov] of Object.entries(raw.routes)) {
      const where = `routes["${key}"]`;
      if (!/^[A-Za-z]+ \/\S*$/.test(key.trim())) throw new ConfigError(file, `${where}: keys look like "GET /users/{id}"`);
      if (!isObject(ov)) throw new ConfigError(file, `${where} must be an object`);
      for (const k of Object.keys(ov)) if (!OVERRIDE_KEYS.has(k)) throw new ConfigError(file, `${where}: unknown option "${k}". Options: ${[...OVERRIDE_KEYS].join(', ')}`);
      if (ov.status !== undefined && !(Number.isInteger(ov.status) && (ov.status as number) >= 100 && (ov.status as number) <= 599)) throw new ConfigError(file, `${where}.status must be an HTTP status code`);
      if (ov.delay !== undefined && !(Number.isInteger(ov.delay) && (ov.delay as number) >= 0)) throw new ConfigError(file, `${where}.delay must be a whole number of milliseconds`);
      if (ov.headers !== undefined && !(isObject(ov.headers) && Object.values(ov.headers).every((v) => typeof v === 'string'))) throw new ConfigError(file, `${where}.headers must map names to strings`);
      if (ov.merge !== undefined && !isObject(ov.merge)) throw new ConfigError(file, `${where}.merge must be an object`);
    }
  }
  return raw as MockConfig;
}

/** Overrides keyed the way the server looks them up: `GET /users/{id}`, method upper-cased. */
export function normalizeRoutes(routes: MockConfig['routes']): Record<string, RouteOverride> {
  const out: Record<string, RouteOverride> = {};
  for (const [key, ov] of Object.entries(routes ?? {})) {
    const [method, ...rest] = key.trim().split(/\s+/);
    out[`${method!.toUpperCase()} ${rest.join(' ')}`] = ov;
  }
  return out;
}

/**
 * Check overrides against the spec. `errors`: keys that match no route (most likely
 * typos; the message lists the real routes). `warnings`: fixed bodies that don't
 * match the spec's schema for their status.
 */
export function checkOverrides(overrides: Record<string, RouteOverride>, model: MockModel): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const validator = new ResponseValidator(model.openapi);
  const keys = new Map(model.routes.map((r) => [`${r.method} ${r.path}`, r]));
  for (const [key, ov] of Object.entries(overrides)) {
    const route = keys.get(key);
    if (!route) {
      errors.push(`routes["${key}"] matches no route in the spec. Routes: ${[...keys.keys()].join(', ')}`);
      continue;
    }
    if (ov.body === undefined || typeof ov.body === 'function') continue;
    const status = ov.status ?? route.responses.find((r) => !r.isDefault && r.status >= 200 && r.status < 300)?.status;
    const schema = route.responses.find((r) => r.status === status)?.schema;
    if (!schema) continue;
    try {
      const result = validator.validate(schema, ov.body);
      if (!result.valid) warnings.push(`routes["${key}"].body doesn't match the spec's ${status} response: ${result.errors}`);
    } catch {
      // The schema can't be compiled (e.g. a non-JavaScript regex); nothing to check against.
    }
  }
  return { errors, warnings };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
