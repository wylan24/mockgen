import { Faker, base, en } from '@faker-js/faker';
import RandExp from 'randexp';
import type { Schema } from './model.js';
import { countMatches, type Discriminator, discriminatorOf, fits, mergeAllOf, mergeBranch, typeOf } from './schema.js';
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

// Filling every optional field of every nested object explodes on big specs (Stripe
// objects nest dozens of expandable objects). Past this depth, or once this many
// values have been generated, only required fields and minItems are filled.
// 250 keeps a Stripe list page of 10 full records near 15 ms (the target is 20 ms
// p95) while every top-level field of a record is still present.
const RICH_DEPTH = 3;
const VALUE_BUDGET = 250;

interface Ctx {
  depth: number;
  maxDepth: number;
  /** Shared across one `generate` call. */
  budget: { values: number };
  /** Only required fields, e.g. to tell apart overlapping `oneOf` branches. */
  minimal?: boolean;
  name?: string;
  record?: RecordContext;
}

/** Generate a realistic, deterministic value that satisfies `schema`. */
export function generate(schema: Schema | undefined, opts: GenerateOptions = {}): unknown {
  faker.seed(hash(`${opts.seed ?? 1}:${opts.key ?? ''}`));
  return gen(schema ?? {}, { depth: 0, maxDepth: opts.maxDepth ?? 8, budget: { values: VALUE_BUDGET } });
}

function gen(schema: Schema, ctx: Ctx): unknown {
  // Real examples beat fake data, unless the spec's example contradicts its own schema.
  if (schema.example !== undefined && fits(schema.example, schema)) return structuredClone(schema.example);
  const example = Array.isArray(schema.examples) ? schema.examples.find((e: unknown) => fits(e, schema)) : undefined;
  if (example !== undefined) return structuredClone(example);
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) {
    // Specs sometimes list enum values their own pattern or maxLength rejects.
    const { enum: values, ...rest } = schema;
    const valid = values.filter((v: unknown) => v !== null && fits(v, rest));
    const options = valid.length ? valid : values.filter((v: unknown) => v !== null);
    return faker.helpers.arrayElement(options.length ? options : values);
  }

  if (Array.isArray(schema.allOf)) return gen(mergeAllOf(schema), ctx);
  const choices: Schema[] | undefined = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(choices) && choices.length) return genChoice(schema, choices, Array.isArray(schema.oneOf), ctx);

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

/**
 * Optional fields real APIs only fill when the client asks (HAL's `_embedded` via
 * `?expand=`). Generating them makes every record several times larger than the real
 * thing. Required ones are still filled.
 */
const ON_REQUEST = new Set(['_embedded']);

function lean(ctx: Ctx): boolean {
  return ctx.minimal === true || ctx.depth > RICH_DEPTH || ctx.budget.values <= 0;
}

/**
 * Pick a `oneOf`/`anyOf` branch and generate from it. Branches often overlap (two
 * object shapes with no required fields both accept `{}`), so each candidate is
 * checked: it must satisfy its branch, and for `oneOf` no other branch.
 */
function genChoice(schema: Schema, choices: Schema[], exclusive: boolean, ctx: Ctx): unknown {
  const rest = choiceBase(schema);
  const disc = discriminatorOf(schema);
  if (disc) return genDiscriminated(rest, disc, ctx);
  // Deep in the tree, prefer the cheapest branch (`string` over an expanded object).
  const order = lean(ctx) ? [...choices].sort((a, b) => cost(a) - cost(b)) : faker.helpers.shuffle([...choices]);
  let fallback: unknown;
  // A rejected candidate must not eat the budget of the next one, or later
  // candidates come out bare and match every branch.
  const budget = ctx.budget.values;
  // Second pass: a full object often satisfies a loose sibling branch too, while
  // the bare required fields of the same branch don't.
  for (const attempt of [ctx, { ...ctx, minimal: true }]) {
    for (const branch of order.slice(0, 4)) {
      const s = Object.keys(rest).length ? mergeBranch(rest, branch) : branch;
      ctx.budget.values = budget;
      const value = gen(s, attempt);
      if (fallback === undefined) fallback = value;
      if (!fits(value, s)) continue;
      if (exclusive && choices.length > 1 && countMatches(value, choices, 0, 2) !== 1) continue;
      return value;
    }
    if (!exclusive) break;
  }
  return fallback;
}

/** With a discriminator the branch is chosen by value, and the record carries that value. */
function genDiscriminated(rest: Schema, disc: Discriminator, ctx: Ctx): unknown {
  const shared = Object.keys(rest).length > 0;
  const branchOf = (m: Discriminator['mapping'][number]) => (shared ? mergeBranch(rest, m.schema) : m.schema);
  // Skip mapping values the branch's own property schema rejects (a spec bug, but common).
  const usable = disc.mapping.filter((m) => {
    const s = branchOf(m);
    const prop = (s.allOf ? mergeAllOf(s) : s).properties?.[disc.property];
    return !prop || fits(m.value, prop);
  });
  const entry = faker.helpers.arrayElement(usable.length ? usable : disc.mapping);
  const value = gen(branchOf(entry), ctx);
  if (value && typeof value === 'object' && !Array.isArray(value)) (value as Record<string, unknown>)[disc.property] = entry.value;
  return value;
}

// Per-schema derived data, cached by identity: schemas never change, records repeat.
const baseCache = new WeakMap<Schema, Schema>();
const siblingCache = new WeakMap<Record<string, Schema>, Set<string>>();

/** A oneOf/anyOf schema minus its alternatives: what every branch is merged with. */
function choiceBase(schema: Schema): Schema {
  let base = baseCache.get(schema);
  if (!base) {
    const { oneOf, anyOf, discriminator, ...rest } = schema;
    baseCache.set(schema, (base = rest));
  }
  return base;
}

function siblingsOf(props: Record<string, Schema>): Set<string> {
  let set = siblingCache.get(props);
  if (!set) siblingCache.set(props, (set = new Set(Object.keys(props).map((k) => k.toLowerCase()))));
  return set;
}

function cost(s: Schema): number {
  if (s.enum || 'const' in s) return 0;
  const t = typeOf(s);
  if (t === 'object') return 2 + (s.required?.length ?? 0);
  if (t === 'array') return 2 + (s.minItems ?? 0);
  if (s.allOf || s.oneOf || s.anyOf) return 3;
  return t ? 1 : 3;
}

function genObject(schema: Schema, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ctx.depth >= ctx.maxDepth) return out;

  const props: Record<string, Schema> = schema.properties ?? {};
  const required = new Set<string>(schema.required ?? []);
  const record: RecordContext = { siblings: siblingsOf(props), owner: ctx.name };
  for (const [name, propSchema] of Object.entries(props)) {
    if (propSchema.writeOnly) continue;
    if (!required.has(name) && (lean(ctx) || ON_REQUEST.has(name))) continue;
    ctx.budget.values--;
    out[name] = gen(propSchema, { ...ctx, depth: ctx.depth + 1, name, record });
  }

  // Required keys the schema never describes still have to be present.
  const extra = typeof schema.additionalProperties === 'object' ? schema.additionalProperties : {};
  for (const name of required) {
    if (!(name in out) && !props[name]?.writeOnly) out[name] = gen(extra, { ...ctx, depth: ctx.depth + 1, name, record });
  }

  if (!schema.properties && schema.additionalProperties && typeof schema.additionalProperties === 'object' && !lean(ctx)) {
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
  // Nested arrays multiply (a list of invoices of line items of taxes): keep inner ones short.
  const max = Math.max(min, schema.maxItems ?? Math.max(min, ctx.depth > 1 ? 3 : 5));
  const count = lean(ctx) ? min : faker.number.int({ min: Math.max(min, Math.min(2, max)), max });
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
  const named = ctx.name && NAMED_FORMATS.has(schema.format) ? namedFormat(schema.format, stringByName(faker, ctx.name, rec, schema)) : undefined;
  let value = named ?? byFormat(schema.format) ?? byPattern(schema.pattern);
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

/** Formats where a name-based value (an avatar URL, a matching email) beats a generic one. */
const NAMED_FORMATS = new Set(['email', 'idn-email', 'uri', 'url', 'iri']);

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
    case 'json-pointer':
      return `/${faker.word.noun()}/${faker.number.int(9)}`;
    case 'relative-json-pointer':
      return `0/${faker.word.noun()}`;
    case 'uri-template':
      return `https://${faker.internet.domainName()}/items/{id}`;
    case 'iri-reference':
      return `/${faker.lorem.slug(2)}`;
    case 'regex':
      return '^[a-z0-9-]+$';
    default:
      return undefined;
  }
}

function byPattern(pattern: string | undefined): string | undefined {
  if (!pattern) return undefined;
  const compiled = patternGenerator(pattern);
  if (!compiled) return undefined;
  for (let i = 0; i < 10; i++) {
    const candidate = compiled.gen.gen();
    if (compiled.re.test(candidate)) return candidate;
  }
  return undefined;
}

// Compiling a RandExp per value dominated pattern-heavy specs; compile once per pattern.
// Its randomness comes from the shared, reseeded faker, so reuse stays deterministic.
const patternCache = new Map<string, { re: RegExp; gen: RandExp } | null>();

function patternGenerator(pattern: string): { re: RegExp; gen: RandExp } | null {
  let compiled = patternCache.get(pattern);
  if (compiled === undefined) {
    try {
      const gen = new RandExp(pattern);
      gen.max = 5; // Cap `*` and `+` so values stay short.
      gen.randInt = (min, max) => faker.number.int({ min, max });
      // Keep generated characters printable ASCII unless the pattern says otherwise.
      gen.defaultRange.subtract(0, 31);
      gen.defaultRange.subtract(127, 65535);
      compiled = { re: new RegExp(pattern, 'u'), gen };
    } catch {
      compiled = null; // Unsupported regex features fall through to a plain string.
    }
    patternCache.set(pattern, compiled);
  }
  return compiled;
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
