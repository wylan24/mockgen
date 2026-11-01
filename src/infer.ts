import { normalizeName, SIGNED_NUMBER } from './heuristics.js';
import type { Schema } from './model.js';

// Schema inference works in two passes: `observe` folds every sample value into an
// accumulator of statistics, then `finalize` turns those statistics into a schema.
// Seeing all samples first is what lets us tell "optional" from "always present",
// "nullable" from "never null", and an enum from free text.

const MAX_TRACKED_VALUES = 50;

/** Keys whose values are free text even when the samples happen to repeat. */
const FREE_TEXT_KEY = /(name|title|description|summary|label|text|message|comment|bio|note|notes|body|content)$/i;

interface Acc {
  /** Times this position was observed, including nulls. */
  seen: number;
  nulls: number;
  booleans: number;
  integers: number;
  floats: number;
  negative: boolean;
  strings: number;
  stringValues: Map<string, number>;
  tooManyValues: boolean;
  /** Detected format per string ('' when none), with counts. */
  formats: Map<string, number>;
  arrays: number;
  items?: Acc;
  objects: number;
  props: Map<string, Acc>;
}

function emptyAcc(): Acc {
  return {
    seen: 0,
    nulls: 0,
    booleans: 0,
    integers: 0,
    floats: 0,
    negative: false,
    strings: 0,
    stringValues: new Map(),
    tooManyValues: false,
    formats: new Map(),
    arrays: 0,
    objects: 0,
    props: new Map(),
  };
}

/** Collects samples for one schema position. Call `add` per sample, then `schema()`. */
export class SchemaInferrer {
  private acc = emptyAcc();

  add(value: unknown): this {
    observe(this.acc, value);
    return this;
  }

  get samples(): number {
    return this.acc.seen;
  }

  schema(): Schema {
    return finalize(this.acc);
  }
}

/** Infer a JSON Schema (OpenAPI 3.1 dialect) that every one of `samples` validates against. */
export function inferSchema(...samples: unknown[]): Schema {
  const inferrer = new SchemaInferrer();
  for (const s of samples) inferrer.add(s);
  return inferrer.schema();
}

function observe(acc: Acc, value: unknown): void {
  acc.seen++;
  if (value === null || value === undefined) {
    acc.nulls++;
  } else if (typeof value === 'boolean') {
    acc.booleans++;
  } else if (typeof value === 'number') {
    if (Number.isInteger(value)) acc.integers++;
    else acc.floats++;
    if (value < 0) acc.negative = true;
  } else if (typeof value === 'string') {
    acc.strings++;
    const format = detectFormat(value);
    acc.formats.set(format, (acc.formats.get(format) ?? 0) + 1);
    if (!acc.tooManyValues) {
      acc.stringValues.set(value, (acc.stringValues.get(value) ?? 0) + 1);
      if (acc.stringValues.size > MAX_TRACKED_VALUES) {
        acc.tooManyValues = true;
        acc.stringValues.clear();
      }
    }
  } else if (Array.isArray(value)) {
    acc.arrays++;
    acc.items ??= emptyAcc();
    for (const item of value) observe(acc.items, item);
  } else if (typeof value === 'object') {
    acc.objects++;
    for (const [key, v] of Object.entries(value)) {
      let prop = acc.props.get(key);
      if (!prop) acc.props.set(key, (prop = emptyAcc()));
      observe(prop, v);
    }
  }
}

function finalize(acc: Acc, key?: string): Schema {
  const variants: Schema[] = [];
  if (acc.objects) variants.push(objectSchema(acc));
  if (acc.arrays) variants.push({ type: 'array', items: acc.items && acc.items.seen ? finalize(acc.items) : {} });
  if (acc.strings) variants.push(stringSchema(acc, key));
  if (acc.integers || acc.floats) {
    // `minimum: 0` only when no sample was negative and the name isn't one that can be (lat, balance, …).
    const signed = acc.negative || (key !== undefined && SIGNED_NUMBER.test(normalizeName(key)));
    variants.push({ type: acc.floats ? 'number' : 'integer', ...(signed ? {} : { minimum: 0 }) });
  }
  if (acc.booleans) variants.push({ type: 'boolean' });

  if (variants.length === 0) return acc.nulls ? { type: 'null' } : {};
  if (variants.length === 1) {
    const only = variants[0]!;
    if (acc.nulls) {
      only.type = [only.type, 'null'];
      if (only.enum) only.enum = [...only.enum, null];
    }
    return only;
  }
  if (acc.nulls) variants.push({ type: 'null' });
  return { anyOf: variants };
}

function objectSchema(acc: Acc): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const [key, prop] of acc.props) {
    properties[key] = finalize(prop, key);
    if (prop.seen === acc.objects) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function stringSchema(acc: Acc, key?: string): Schema {
  const formats = [...acc.formats.keys()];
  if (formats.length === 1 && formats[0]) return { type: 'string', format: formats[0] };

  // A handful of short values repeated across many samples is an enum (`status`, `role`).
  const values = [...acc.stringValues.keys()];
  const looksLikeEnum =
    !acc.tooManyValues &&
    !(key && FREE_TEXT_KEY.test(key)) &&
    acc.strings >= 4 &&
    values.length <= Math.min(8, acc.strings / 2) &&
    values.every((v) => v.length > 0 && v.length <= 24 && !/^\d+$/.test(v) && !/\s{2,}/.test(v));
  if (looksLikeEnum) return { type: 'string', enum: values.sort() };
  return { type: 'string' };
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URI = /^https?:\/\/[^\s]+$/;

function detectFormat(s: string): string {
  if (DATE_TIME.test(s) && isRealDate(s.slice(0, 10))) return /^.{10}[Tt]/.test(s) ? 'date-time' : '';
  if (DATE.test(s) && isRealDate(s)) return 'date';
  if (UUID.test(s)) return 'uuid';
  if (EMAIL.test(s)) return 'email';
  if (URI.test(s) && URL.canParse(s)) return 'uri';
  return '';
}

/** `2024-02-30` matches the regex but isn't a date; validators reject it, so we must too. */
function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}
