import { isIPv4, isIPv6 } from 'node:net';
import type { Schema } from './model.js';

// Small schema helpers shared by the generator, server and collections.

export function typeOf(schema: Schema): string | undefined {
  let t = schema.type;
  if (Array.isArray(t)) {
    // 3.1 nullable: prefer the non-null type so data looks real.
    const nonNull = t.filter((x: string) => x !== 'null');
    t = nonNull[0] ?? 'null';
  }
  if (t) return t;
  if (schema.properties || schema.additionalProperties) return 'object';
  if (schema.items) return 'array';
  if (schema.format || schema.pattern || schema.minLength !== undefined) return 'string';
  if (schema.minimum !== undefined || schema.maximum !== undefined) return 'number';
  return undefined;
}

const LOWER_BOUNDS = new Set(['minimum', 'minLength', 'minItems', 'minProperties']);
const UPPER_BOUNDS = new Set(['maximum', 'maxLength', 'maxItems', 'maxProperties']);

/**
 * Merge `allOf` members into one schema: properties and required lists combine.
 * A member with `additionalProperties: false` only allows its own properties, so
 * properties from other members are dropped (that's what a validator enforces).
 */
export function mergeAllOf(schema: Schema): Schema {
  const { allOf, ...rest } = schema;
  const merged: Schema = { ...rest };
  const closed: Set<string>[] = [];
  if (rest.additionalProperties === false && rest.properties) closed.push(new Set(Object.keys(rest.properties)));
  for (const part of allOf as Schema[]) {
    if (part.additionalProperties === false) closed.push(new Set(Object.keys(part.properties ?? {})));
    const flat = part.allOf ? mergeAllOf(part) : part;
    for (const [k, v] of Object.entries(flat)) {
      if (k === 'properties') merged.properties = { ...merged.properties, ...v };
      else if (k === 'required') merged.required = [...new Set([...(merged.required ?? []), ...v])];
      else if (!(k in merged)) merged[k] = v;
      // Every member applies, so constraints narrow rather than first-one-wins.
      else if (k === 'enum' && Array.isArray(v)) merged.enum = merged.enum.filter((e: unknown) => v.some((x: unknown) => JSON.stringify(x) === JSON.stringify(e)));
      else if (LOWER_BOUNDS.has(k) && typeof v === 'number') merged[k] = Math.max(merged[k], v);
      else if (UPPER_BOUNDS.has(k) && typeof v === 'number') merged[k] = Math.min(merged[k], v);
    }
  }
  if (closed.length && merged.properties) {
    merged.properties = Object.fromEntries(Object.entries(merged.properties).filter(([k]) => closed.every((allowed) => allowed.has(k))));
  }
  return merged;
}

/**
 * Whether `value` validates against `schema` — a compact validator covering the
 * keywords OpenAPI uses, used to reject bad spec examples and to keep `oneOf`
 * branches from overlapping. Returns false when there is no schema at all.
 */
export function fits(value: unknown, schema: Schema | undefined): boolean {
  return schema !== undefined && check(value, schema, 0);
}

const MAX_DEPTH = 64;

function check(value: unknown, schema: Schema | boolean | undefined, depth: number): boolean {
  if (schema === undefined || schema === true) return true;
  if (schema === false) return false;
  if (depth > MAX_DEPTH) return true;
  const s = schema;
  const d = depth + 1;

  if (value === null && s.nullable === true) return true; // OpenAPI 3.0
  if (Array.isArray(s.enum) && !s.enum.some((e: unknown) => equal(e, value))) return false;
  if ('const' in s && !equal(s.const, value)) return false;
  if (Array.isArray(s.allOf) && !s.allOf.every((p: Schema) => check(value, p, d))) return false;
  if (Array.isArray(s.anyOf) && !s.anyOf.some((p: Schema) => check(value, p, d))) return false;
  if (Array.isArray(s.oneOf) && countMatches(value, s.oneOf, d, 2) !== 1) return false;
  if (s.not !== undefined && check(value, s.not, d)) return false;

  const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (types.length && !types.some((t) => isType(value, t))) return false;

  if (typeof value === 'number') return checkNumber(value, s);
  if (typeof value === 'string') return checkString(value, s);
  if (Array.isArray(value)) return checkArray(value, s, d);
  if (value && typeof value === 'object') return checkObject(value as Record<string, unknown>, s, d);
  return true;
}

/** How many of `schemas` the value matches, stopping early at `stopAt`. */
export function countMatches(value: unknown, schemas: Schema[], depth = 0, stopAt = Infinity): number {
  let n = 0;
  for (const s of schemas) if (check(value, s, depth) && ++n >= stopAt) break;
  return n;
}

function isType(v: unknown, t: string): boolean {
  switch (t) {
    case 'null':
      return v === null;
    case 'integer':
      return Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return !!v && typeof v === 'object' && !Array.isArray(v);
    default:
      return false;
  }
}

function checkNumber(n: number, s: Schema): boolean {
  if (s.minimum !== undefined && (s.exclusiveMinimum === true ? n <= s.minimum : n < s.minimum)) return false;
  if (s.maximum !== undefined && (s.exclusiveMaximum === true ? n >= s.maximum : n > s.maximum)) return false;
  if (typeof s.exclusiveMinimum === 'number' && n <= s.exclusiveMinimum) return false;
  if (typeof s.exclusiveMaximum === 'number' && n >= s.exclusiveMaximum) return false;
  if (s.multipleOf) {
    const q = n / s.multipleOf;
    if (Math.abs(q - Math.round(q)) > 1e-9) return false;
  }
  if (s.format === 'int32') return Number.isInteger(n) && n >= -(2 ** 31) && n < 2 ** 31;
  if (s.format === 'int64') return Number.isInteger(n);
  return true;
}

function checkString(v: string, s: Schema): boolean {
  const length = [...v].length;
  if (s.minLength !== undefined && length < s.minLength) return false;
  if (s.maxLength !== undefined && length > s.maxLength) return false;
  if (s.pattern) {
    try {
      if (!new RegExp(s.pattern, 'u').test(v)) return false;
    } catch {
      return false;
    }
  }
  const format = s.format && FORMATS[s.format];
  return !format || format(v);
}

function checkArray(v: unknown[], s: Schema, d: number): boolean {
  if (s.minItems !== undefined && v.length < s.minItems) return false;
  if (s.maxItems !== undefined && v.length > s.maxItems) return false;
  if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) return false;
  const prefix: Schema[] = s.prefixItems ?? [];
  return v.every((item, i) => check(item, i < prefix.length ? prefix[i] : s.items, d));
}

function checkObject(v: Record<string, unknown>, s: Schema, d: number): boolean {
  const props: Record<string, Schema> = s.properties ?? {};
  for (const key of s.required ?? []) {
    // Responses never carry writeOnly fields, even required ones.
    if (!(key in v) && !props[key]?.writeOnly) return false;
  }
  const keys = Object.keys(v);
  if (s.minProperties !== undefined && keys.length < s.minProperties) return false;
  if (s.maxProperties !== undefined && keys.length > s.maxProperties) return false;
  const patterns = Object.entries<Schema>(s.patternProperties ?? {});
  for (const key of keys) {
    if (key in props) {
      if (!check(v[key], props[key], d)) return false;
      continue;
    }
    const matched = patterns.filter(([p]) => safeTest(p, key));
    if (matched.length) {
      if (!matched.every(([, ps]) => check(v[key], ps, d))) return false;
    } else if (s.additionalProperties !== undefined && !check(v[key], s.additionalProperties, d)) {
      return false;
    }
  }
  return true;
}

function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(value);
  } catch {
    return false;
  }
}

function equal(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Characters RFC 3986 never allows unescaped — `{id}` placeholders in examples trip validators. */
function uriChars(v: string): boolean {
  if (/^(https?|ftp):/i.test(v)) {
    // WHATWG URL parsing accepts hosts like `***`; RFC 3986 validators don't.
    const host = /^[a-z]+:\/\/(?:[^@/?#]*@)?([^/?#:]*)/i.exec(v)?.[1] ?? '';
    if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)$/i.test(host)) return false;
  }
  return !/[\s{}<>"\^`|]/.test(v) && !/%(?![0-9a-f]{2})/i.test(v);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function isDate(v: string): boolean {
  const m = DATE.exec(v);
  if (!m) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.getUTCDate() === Number(m[3]);
}

/** Formats checked as strictly as Ajv's `ajv-formats`, so passing here means passing there. */
const FORMATS: Record<string, (v: string) => boolean> = {
  date: isDate,
  time: (v) => TIME.test(v),
  'date-time': (v) => {
    const i = v.search(/[Tt ]/);
    return i === 10 && isDate(v.slice(0, 10)) && TIME.test(v.slice(11));
  },
  uuid: (v) => /^(urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  email: (v) => /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(v),
  uri: (v) => /^[a-z][a-z0-9+.-]*:/i.test(v) && uriChars(v) && URL.canParse(v),
  url: (v) => /^(https?|ftp):\/\//i.test(v) && uriChars(v) && URL.canParse(v),
  'uri-reference': uriChars,
  hostname: (v) => /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i.test(v),
  ipv4: (v) => isIPv4(v),
  ipv6: (v) => isIPv6(v),
  'json-pointer': (v) => /^(?:\/(?:[^~/]|~0|~1)*)*$/.test(v),
  regex: (v) => {
    try {
      new RegExp(v, 'u');
      return true;
    } catch {
      return false;
    }
  },
};
