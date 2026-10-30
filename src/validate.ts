import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { Schema } from './model.js';

// Validates generated responses against their schemas. OpenAPI schemas aren't quite
// JSON Schema (3.0 has `nullable` and boolean exclusive bounds), and dereferenced
// specs contain object cycles Ajv can't compile, so each schema is first rewritten
// into plain JSON Schema with shared and circular parts moved into `$defs`.

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;

/** Keywords whose values are schemas, maps of schemas, or arrays of schemas. */
const SCHEMA_KEYWORDS = new Set(['additionalProperties', 'items', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems']);
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']);
/** OpenAPI-only keywords that mean nothing to a validator. */
const DROPPED_KEYWORDS = new Set(['discriminator', 'xml', 'externalDocs', 'example', 'deprecated']);

export interface ValidationResult {
  valid: boolean;
  /** Human-readable errors when invalid. */
  errors?: string;
}

export class ResponseValidator {
  private ajv = new Ajv2020({ strict: false, allErrors: false, logger: false, validateSchema: false });
  private ids = new WeakMap<Schema, string>();
  private failed = new WeakSet<Schema>();
  private nextId = 0;
  private readonly openapi30: boolean;

  /** @param openapi the spec's `openapi` version; 3.0 schemas get converted. */
  constructor(openapi = '3.1.0') {
    addFormats(this.ajv);
    this.openapi30 = openapi.startsWith('3.0');
  }

  /** Validate a value; throws if the schema itself can't be compiled (e.g. a non-JS regex). */
  validate(schema: Schema, value: unknown): ValidationResult {
    if (this.failed.has(schema)) throw new Error('schema could not be compiled');
    let fn: ValidateFunction | undefined;
    try {
      fn = this.ajv.getSchema(this.register(schema));
    } catch (err) {
      this.failed.add(schema);
      throw err;
    }
    if (!fn) throw new Error('schema could not be compiled');
    return fn(value) ? { valid: true } : { valid: false, errors: this.ajv.errorsText(fn.errors) };
  }

  // Every object-like schema is registered with Ajv once, under an id, and referenced
  // from everywhere else. Shared and circular parts of big specs then compile once.
  private register(node: Schema): string {
    let id = this.ids.get(node);
    if (!id) {
      id = `mock:s${this.nextId++}`;
      this.ids.set(node, id); // Before converting, so cycles find it.
      this.ajv.addSchema({ $id: id, ...convertObject(node, this.openapi30, (child) => this.child(child)) });
    }
    return id;
  }

  private child(node: unknown): unknown {
    if (!isObject(node)) return node;
    return isComposite(node) ? { $ref: this.register(node) } : convertObject(node, this.openapi30, (c) => this.child(c));
  }
}

/** Rewrite a dereferenced (possibly cyclic) OpenAPI schema as one self-contained JSON Schema. */
export function toJsonSchema(root: Schema, openapi30: boolean): Schema {
  // Pass 1: count how often each schema object is reached; shared ones become $defs.
  const refs = new Map<object, number>();
  const count = (node: unknown) => {
    if (!isObject(node)) return;
    const n = (refs.get(node) ?? 0) + 1;
    refs.set(node, n);
    if (n === 1) forEachSubschema(node, count);
  };
  count(root);

  const defs: Record<string, Schema> = {};
  const names = new Map<object, string>();
  const convert = (node: unknown): unknown => {
    if (!isObject(node)) return node;
    if ((refs.get(node) ?? 0) > 1) {
      let name = names.get(node);
      if (!name) {
        name = `s${names.size}`;
        names.set(node, name);
        defs[name] = convertObject(node, openapi30, convert);
      }
      return { $ref: `#/$defs/${name}` };
    }
    return convertObject(node, openapi30, convert);
  };

  const schema = convertObject(root, openapi30, convert);
  return Object.keys(defs).length ? { ...schema, $defs: { ...schema.$defs, ...defs } } : schema;
}

/** Convert one schema object's own keywords; `child` converts nested schemas. */
function convertObject(node: Schema, openapi30: boolean, child: (s: unknown) => unknown): Schema {
  const out: Schema = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('x-') || DROPPED_KEYWORDS.has(k) || (openapi30 && k === 'nullable')) continue;
    if (SCHEMA_KEYWORDS.has(k)) out[k] = typeof v === 'boolean' ? v : child(v);
    else if (SCHEMA_ARRAY_KEYWORDS.has(k) && Array.isArray(v)) out[k] = v.map(child);
    else if (SCHEMA_MAP_KEYWORDS.has(k) && isObject(v)) out[k] = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, child(s)]));
    else if (k !== '$id' && k !== '$schema') out[k] = v;
  }

  // Responses never contain writeOnly properties, so they can't be required there.
  if (isObject(node.properties)) {
    const writeOnly = Object.keys(node.properties).filter((p) => (node.properties[p] as Schema)?.writeOnly);
    for (const p of writeOnly) delete out.properties[p];
    if (Array.isArray(out.required)) out.required = out.required.filter((r: string) => !writeOnly.includes(r));
  }

  if (openapi30) {
    for (const [bound, exclusive] of [['minimum', 'exclusiveMinimum'], ['maximum', 'exclusiveMaximum']] as const) {
      if (out[exclusive] === true) {
        out[exclusive] = out[bound];
        delete out[bound];
      } else if (out[exclusive] === false) {
        delete out[exclusive];
      }
    }
    if (node.nullable === true) {
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
      if (typeof out.type === 'string') out.type = [out.type, 'null'];
      else if (!out.type) return { anyOf: [out, { type: 'null' }] };
    }
  }
  return out;
}

function isComposite(node: Schema): boolean {
  return !!(node.properties || node.allOf || node.anyOf || node.oneOf || node.items || node.additionalProperties);
}

function forEachSubschema(node: Schema, fn: (s: unknown) => void) {
  for (const [k, v] of Object.entries(node)) {
    if (SCHEMA_KEYWORDS.has(k)) fn(v);
    else if (SCHEMA_ARRAY_KEYWORDS.has(k) && Array.isArray(v)) v.forEach(fn);
    else if (SCHEMA_MAP_KEYWORDS.has(k) && isObject(v)) Object.values(v).forEach(fn);
  }
}

function isObject(v: unknown): v is Schema {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
