// Request validation: check an incoming request against its operation in the spec.
// Path, query and header values arrive as text, so each is first converted to the
// type its schema expects ("5" → 5, "a,b" → ["a", "b"]) and then validated.
import type { MockRoute, Schema } from './model.js';
import type { ResponseValidator } from './validate.js';

export interface RequestIssue {
  in: 'path' | 'query' | 'header' | 'body';
  /** The parameter's name; absent for the body. */
  name?: string;
  /** JSON Pointer inside the value, e.g. `/title`; empty for the value itself. */
  path?: string;
  message: string;
}

export interface RequestParts {
  /** Path parameters, already decoded, by name. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Header values by lower-cased name. */
  headers: Record<string, string | undefined>;
  /** The parsed JSON body; undefined when there was none. */
  body?: unknown;
  /** True when the request had a body, even one that wasn't JSON. */
  hasBody?: boolean;
}

/** OpenAPI says these header parameters are ignored: the protocol defines them. */
const IGNORED_HEADERS = new Set(['accept', 'content-type', 'authorization']);

/** Everything wrong with a request, by the route's parameters and body in the spec. An empty list means it's valid. */
export function checkRequest(route: MockRoute, parts: RequestParts, validator: ResponseValidator): RequestIssue[] {
  const issues: RequestIssue[] = [];
  for (const p of route.parameters ?? []) {
    if (p.in === 'cookie' || (p.in === 'header' && IGNORED_HEADERS.has(p.name.toLowerCase()))) continue;
    // Object query parameters usually arrive deepObject style: `created[gt]=1&created[lt]=9`.
    const deep = p.in === 'query' && p.schema && types(p.schema).includes('object') ? deepObject(parts.query, p.name, p.schema) : undefined;
    const raw = p.in === 'path' ? present(parts.params[p.name]) : p.in === 'query' ? present(...parts.query.getAll(p.name)) : present(parts.headers[p.name.toLowerCase()]);
    if (!raw && !deep) {
      if (p.required) issues.push({ in: p.in, name: p.name, message: 'is required' });
      continue;
    }
    if (!p.schema) continue;
    // The text could be meant as more than one type ("a string or an array"): valid if any reading is.
    let found: { path?: string; message: string }[] | undefined;
    for (const value of deep ? [deep] : readings(raw!, p.schema)) {
      const problems = validate(validator, p.schema, value);
      if (!problems.length) {
        found = [];
        break;
      }
      found ??= problems; // Report the first (converted) reading's problems: they're the most telling.
    }
    for (const issue of found ?? []) issues.push({ in: p.in, name: p.name, ...issue });
  }

  const body = route.requestBody;
  if (body) {
    if (!parts.hasBody) {
      if (body.required) issues.push({ in: 'body', message: 'is required' });
    } else if (body.schema && parts.body !== undefined) {
      for (const issue of validate(validator, body.schema, parts.body)) issues.push({ in: 'body', ...issue });
    }
  }
  return issues;
}

/** One line per issue, e.g. `query limit: must be <= 50` or `body /title: must be string`. */
export function describeIssue(issue: RequestIssue): string {
  const where = [issue.in, issue.name, issue.path].filter(Boolean).join(' ');
  return `${where}: ${issue.message}`;
}

function present(...values: (string | undefined)[]): string[] | undefined {
  const found = values.filter((v): v is string => v !== undefined && v !== '');
  return found.length ? found : undefined;
}

function validate(validator: ResponseValidator, schema: Schema, value: unknown): { path?: string; message: string }[] {
  try {
    const result = validator.validate(schema, value);
    return result.valid ? [] : (result.issues ?? [{ path: '', message: result.errors ?? 'is invalid' }]).map((i) => ({ path: i.path || undefined, message: i.message }));
  } catch {
    return []; // The schema itself can't be compiled (e.g. a non-JavaScript regex): nothing to check against.
  }
}

/** The ways to read a parameter's text: converted to the schema's type first, then as plain text. */
function readings(values: string[], schema: Schema): unknown[] {
  const converted = coerce(values, schema);
  const text = values.length === 1 ? values[0] : values;
  return JSON.stringify(converted) === JSON.stringify(text) ? [converted] : [converted, text];
}

/** Text from the URL or a header, as the type the schema wants. Values that don't convert stay text, so validation reports them. */
function coerce(values: string[], schema: Schema): unknown {
  if (types(schema).includes('array')) {
    const items = values.length > 1 ? values : values[0]!.split(',');
    return items.map((v) => coerceOne(v, schema.items ?? {}));
  }
  return coerceOne(values[0]!, schema);
}

/** `name[key]=value` pairs as an object, each value converted by its property's schema; undefined if there are none. */
function deepObject(query: URLSearchParams, name: string, schema: Schema): Record<string, unknown> | undefined {
  const prefix = `${name}[`;
  // The object's properties, from the schema or from its object branch ("a range or an integer").
  const branch = [schema, ...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].find((s: Schema) => s?.properties);
  const props: Record<string, Schema> = branch?.properties ?? {};
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of query) {
    if (!key.startsWith(prefix) || !key.endsWith(']')) continue;
    const prop = key.slice(prefix.length, -1);
    out ??= {};
    out[prop] = coerceOne(value, props[prop] ?? {});
  }
  return out;
}

function coerceOne(value: string, schema: Schema): unknown {
  const t = types(schema);
  // Some APIs put JSON in a query parameter: `filter={"status":"open"}`.
  if ((t.includes('object') || t.includes('array')) && /^\s*[[{]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      // Not JSON after all; validate the text as it is.
    }
  }
  if ((t.includes('integer') || t.includes('number')) && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  if (t.includes('boolean') && (value === 'true' || value === 'false')) return value === 'true';
  if (t.includes('null') && value === 'null') return null;
  return value;
}

function types(schema: Schema): string[] {
  if (Array.isArray(schema.type)) return schema.type;
  if (typeof schema.type === 'string') return [schema.type];
  if (schema.properties) return ['object'];
  // `allOf`/`oneOf` parameter schemas: look one level in. A branch with properties is an object.
  return [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].flatMap((s: Schema) =>
    !s ? [] : typeof s.type === 'string' ? [s.type] : s.properties ? ['object'] : [],
  );
}
