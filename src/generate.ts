import { Faker, base, en } from '@faker-js/faker';
import RandExp from 'randexp';
import type { Schema } from './model.js';
import { looksLikeDate, looksLikeDateTime, numberByName, stringByName, type RecordContext } from './heuristics.js';

export interface GenerateOptions {
  /** Global seed; the same seed + key always yields the same value. */
  seed?: number;
  /** Distinguishes values under one seed, e.g. `GET /users/42 200`. */
  key?: string;
  /** Recursion limit for circular schemas. */
  maxDepth?: number;
}

// Faker's date helpers default to "now"; pin them so output never drifts.
const REF_DATE = new Date('2026-01-01T00:00:00.000Z');

const faker = new Faker({ locale: [en, base] });
faker.setDefaultRefDate(REF_DATE);

interface Ctx {
  depth: number;
  maxDepth: number;
  name?: string;
  record?: RecordContext;
}

/** Generate a realistic, deterministic value that satisfies `schema`. */
export function generate(schema: Schema | undefined, opts: GenerateOptions = {}): unknown {
  faker.seed(hash(`${opts.seed ?? 1}:${opts.key ?? ''}`));
  return gen(schema ?? {}, { depth: 0, maxDepth: opts.maxDepth ?? 8 });
}

function gen(schema: Schema, ctx: Ctx): unknown {
  if (schema.example !== undefined) return structuredClone(schema.example);
  if (Array.isArray(schema.examples) && schema.examples.length) return structuredClone(schema.examples[0]);
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const options = schema.enum.filter((v: unknown) => v !== null);
    return faker.helpers.arrayElement(options.length ? options : schema.enum);
  }

  if (Array.isArray(schema.allOf)) return gen(mergeAllOf(schema), ctx);
  const choices = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(choices) && choices.length) {
    const { oneOf, anyOf, ...rest } = schema;
    const pick = faker.helpers.arrayElement(choices as Schema[]);
    return gen(Object.keys(rest).length ? mergeAllOf({ allOf: [rest, pick] }) : pick, ctx);
  }

  switch (typeOf(schema)) {
    case 'null':
      return null;
    case 'object':
      return genObject(schema, ctx);
    case 'array':
      return genArray(schema, ctx);
    case 'integer':
      return genNumber(schema, ctx, true);
    case 'number':
      return genNumber(schema, ctx, false);
    case 'boolean':
      return faker.datatype.boolean();
    case 'string':
      return genString(schema, ctx);
    default:
      return faker.word.noun();
  }
}

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

function genObject(schema: Schema, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ctx.depth >= ctx.maxDepth) return out;

  const props: Record<string, Schema> = schema.properties ?? {};
  const record: RecordContext = { siblings: new Set(Object.keys(props).map((k) => k.toLowerCase())), owner: ctx.name };
  for (const [name, propSchema] of Object.entries(props)) {
    if (propSchema.writeOnly) continue;
    out[name] = gen(propSchema, { ...ctx, depth: ctx.depth + 1, name, record });
  }

  if (!schema.properties && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    const count = faker.number.int({ min: 1, max: 3 });
    for (let i = 0; i < count; i++) {
      out[faker.word.noun()] = gen(schema.additionalProperties, { ...ctx, depth: ctx.depth + 1, name: undefined });
    }
  }
  return out;
}

function genArray(schema: Schema, ctx: Ctx): unknown[] {
  const min = schema.minItems ?? 0;
  if (ctx.depth >= ctx.maxDepth) return [];
  const max = Math.max(min, schema.maxItems ?? Math.max(min, 5));
  const count = faker.number.int({ min: Math.max(min, Math.min(2, max)), max });
  const items: Schema = schema.items ?? {};
  // Items of a `users` array are users, so keep the singular name as the hint.
  const name = ctx.name?.replace(/ies$/, 'y').replace(/(ss|x|sh|ch|us)es$/, '$1').replace(/([^s])s$/, '$1');
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (let attempts = 0; out.length < count && attempts < count * 5; attempts++) {
    const value = gen(items, { ...ctx, depth: ctx.depth + 1, name, record: undefined });
    if (schema.uniqueItems) {
      const k = JSON.stringify(value);
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(value);
  }
  return out;
}

function genNumber(schema: Schema, ctx: Ctx, integer: boolean): number {
  let lo = schema.minimum ?? -Infinity;
  let hi = schema.maximum ?? Infinity;
  // 3.0 uses booleans for exclusive bounds; 3.1 uses numbers.
  const step = integer ? 1 : 0.01;
  if (typeof schema.exclusiveMinimum === 'number') lo = Math.max(lo, schema.exclusiveMinimum + step);
  else if (schema.exclusiveMinimum === true) lo += step;
  if (typeof schema.exclusiveMaximum === 'number') hi = Math.min(hi, schema.exclusiveMaximum - step);
  else if (schema.exclusiveMaximum === true) hi -= step;

  const hinted = ctx.name ? numberByName(faker, ctx.name, integer || schema.format === 'int64' || schema.format === 'int32') : undefined;
  let value: number;
  if (hinted !== undefined && hinted >= lo && hinted <= hi) {
    value = hinted;
  } else {
    const min = Number.isFinite(lo) ? lo : Number.isFinite(hi) ? hi - 1000 : 0;
    const max = Number.isFinite(hi) ? hi : min + 1000;
    value = integer
      ? faker.number.int({ min: Math.ceil(min), max: Math.floor(max) })
      : faker.number.float({ min, max, fractionDigits: 2 });
  }

  if (schema.multipleOf) {
    const m = schema.multipleOf;
    let snapped = Math.round(value / m) * m;
    if (snapped < lo) snapped += m;
    if (snapped > hi) snapped -= m;
    value = Number(snapped.toFixed(10));
  }
  if (integer) value = Math.round(value);
  return value;
}

function genString(schema: Schema, ctx: Ctx): string {
  const rec = ctx.record ?? { siblings: new Set<string>() };
  // `avatarUrl: {format: uri}` should still be an avatar, and `email` should match `firstName`.
  let value = (ctx.name ? namedFormat(schema.format, stringByName(faker, ctx.name, rec, schema)) : undefined) ?? byFormat(schema.format) ?? byPattern(schema.pattern);
  if (value === undefined && ctx.name) {
    if (looksLikeDate(ctx.name)) value = isoDate(faker.date.birthdate());
    else if (looksLikeDateTime(ctx.name)) value = faker.date.past({ years: 2 }).toISOString();
    else value = stringByName(faker, ctx.name, rec, schema);
  }
  value ??= faker.lorem.words({ min: 1, max: 3 });

  if (schema.format || schema.pattern) return value;
  const min = schema.minLength ?? 0;
  const max = schema.maxLength ?? Infinity;
  while (value.length < min) value += faker.string.alpha({ length: min - value.length, casing: 'lower' });
  if (value.length > max) value = value.slice(0, max);
  return value;
}

/** Keep a name-based value when it also satisfies the generic format. */
function namedFormat(format: string | undefined, candidate: string | undefined): string | undefined {
  if (candidate === undefined) return undefined;
  if (format === 'email' || format === 'idn-email') return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate) ? candidate : undefined;
  if (format === 'uri' || format === 'url' || format === 'iri') return URL.canParse(candidate) ? candidate : undefined;
  return undefined;
}

function byFormat(format: string | undefined): string | undefined {
  switch (format) {
    case 'email':
    case 'idn-email':
      return faker.internet.email().toLowerCase();
    case 'uri':
    case 'url':
    case 'iri':
      return faker.internet.url();
    case 'uri-reference':
      return `/${faker.lorem.slug(2)}`;
    case 'uuid':
      return faker.string.uuid();
    case 'date':
      return isoDate(faker.date.past({ years: 2 }));
    case 'date-time':
      return faker.date.past({ years: 2 }).toISOString();
    case 'time':
      return `${faker.date.past().toISOString().slice(11, 19)}Z`;
    case 'duration':
      return `PT${faker.number.int({ min: 1, max: 59 })}M`;
    case 'ipv4':
      return faker.internet.ipv4();
    case 'ipv6':
      return faker.internet.ipv6();
    case 'hostname':
    case 'idn-hostname':
      return faker.internet.domainName();
    case 'byte':
      return Buffer.from(faker.lorem.words(3)).toString('base64');
    case 'binary':
      return faker.string.alphanumeric(16);
    case 'password':
      return faker.internet.password({ length: 16 });
    default:
      return undefined;
  }
}

function byPattern(pattern: string | undefined): string | undefined {
  if (!pattern) return undefined;
  try {
    const re = new RegExp(pattern, 'u');
    const gen = new RandExp(pattern);
    gen.max = 5; // Cap `*` and `+` so values stay short.
    gen.randInt = (min, max) => faker.number.int({ min, max });
    // Keep generated characters printable ASCII unless the pattern says otherwise.
    gen.defaultRange.subtract(0, 31);
    gen.defaultRange.subtract(127, 65535);
    for (let i = 0; i < 10; i++) {
      const candidate = gen.gen();
      if (re.test(candidate)) return candidate;
    }
  } catch {
    // Unsupported regex features fall through to a plain string.
  }
  return undefined;
}

/** Shallow-merge `allOf` members into one schema: properties and required lists combine. */
export function mergeAllOf(schema: Schema): Schema {
  const { allOf, ...rest } = schema;
  const merged: Schema = { ...rest };
  for (const part of allOf as Schema[]) {
    const flat = part.allOf ? mergeAllOf(part) : part;
    for (const [k, v] of Object.entries(flat)) {
      if (k === 'properties') merged.properties = { ...merged.properties, ...v };
      else if (k === 'required') merged.required = [...new Set([...(merged.required ?? []), ...v])];
      else if (!(k in merged)) merged[k] = v;
    }
  }
  return merged;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 32-bit FNV-1a; stable across platforms and Node versions. */
export function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
