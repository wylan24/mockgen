import { describe, expect, it } from 'vitest';
import { generate } from '../src/generate.js';
import { ResponseValidator, toJsonSchema } from '../src/validate.js';

describe('ResponseValidator', () => {
  it('understands OpenAPI 3.0 nullable and boolean exclusive bounds', () => {
    const v = new ResponseValidator('3.0.3');
    expect(v.validate({ type: 'string', nullable: true }, null).valid).toBe(true);
    expect(v.validate({ type: 'string', enum: ['a'], nullable: true }, null).valid).toBe(true);
    expect(v.validate({ allOf: [{ type: 'object' }], nullable: true }, null).valid).toBe(true);
    expect(v.validate({ type: 'integer', minimum: 0, exclusiveMinimum: true }, 0).valid).toBe(false);
    expect(v.validate({ type: 'integer', minimum: 0, exclusiveMinimum: true }, 1).valid).toBe(true);
  });

  it('treats 3.1 schemas as JSON Schema', () => {
    const v = new ResponseValidator('3.1.0');
    expect(v.validate({ type: ['string', 'null'] }, null).valid).toBe(true);
    expect(v.validate({ type: 'number', exclusiveMinimum: 0 }, 0).valid).toBe(false);
  });

  it('ignores writeOnly properties in responses', () => {
    const v = new ResponseValidator();
    const schema = { type: 'object', required: ['id', 'password'], properties: { id: { type: 'integer' }, password: { type: 'string', writeOnly: true } } };
    expect(v.validate(schema, { id: 1 }).valid).toBe(true);
  });

  it('handles circular and shared schemas', () => {
    const node: any = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
    node.properties.children = { type: 'array', items: node };
    node.properties.parent = node;
    const v = new ResponseValidator();
    expect(v.validate(node, { name: 'a', children: [{ name: 'b', children: [] }] }).valid).toBe(true);
    expect(v.validate(node, { name: 'a', children: [{ children: [] }] }).valid).toBe(false);
    expect(v.validate(node, generate(node, { seed: 1 })).valid).toBe(true);
  });

  it('reports errors in words', () => {
    const r = new ResponseValidator().validate({ type: 'object', required: ['id'] }, {});
    expect(r.errors).toMatch(/must have required property 'id'/);
  });

  it('throws for schemas it cannot compile', () => {
    expect(() => new ResponseValidator().validate({ type: 'string', pattern: '(?<!' }, 'x')).toThrow();
  });
});

describe('toJsonSchema', () => {
  it('moves shared and circular parts into $defs', () => {
    const shared = { type: 'string', format: 'email' };
    const node: any = { type: 'object', properties: { a: shared, b: shared } };
    node.properties.self = node;
    const out = toJsonSchema(node, false);
    expect(out.properties.a).toEqual({ $ref: '#/$defs/s0' });
    expect(out.$defs.s0).toEqual(shared);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

describe('spec examples', () => {
  it('are skipped when they contradict their own schema', () => {
    // Seen in Asana's spec: a date example on a date-time field.
    const v = generate({ type: 'string', format: 'date-time', example: '2019-09-15' }, { seed: 1 }) as string;
    expect(v).not.toBe('2019-09-15');
    expect(v).toMatch(/T/);
    expect(generate({ type: 'string', enum: ['a', 'b'], example: 'c' }, { seed: 1 })).not.toBe('c');
  });
});

// Regression cases found by the real-world spec corpus (npm run corpus).
describe('corpus regressions', () => {
  const v = new ResponseValidator('3.0.3');
  const valid = (schema: object, seeds = 20) => {
    for (let seed = 1; seed <= seeds; seed++) {
      const value = generate(schema, { seed });
      const r = v.validate(schema, value);
      expect(r.valid, `seed ${seed}: ${JSON.stringify(value)} ${r.errors}`).toBe(true);
    }
  };

  it('rejects nested examples that break the schema (Zuora, Codat)', () => {
    valid({ type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, example: { id: '6e569e1e05f040eda51a927b140c0ac3' } });
    valid({ type: 'string', format: 'date-time', example: '2018-01-01T00:01:01' });
    valid({ type: 'string', format: 'uri-reference', example: '/companies/{id}' });
    valid({ type: 'string', format: 'url', example: 'https://***' });
  });

  it('only picks enum values that fit the rest of the schema (Twitter)', () => {
    valid({ type: 'string', pattern: '^[A-Za-z]{1,12}$', enum: ['everyone', 'mentionedUsers', 'following'] });
  });

  it('keeps oneOf branches from overlapping (GitHub)', () => {
    valid({
      oneOf: [
        { type: 'object', required: ['message', 'documentation_url'], properties: { message: { type: 'string' }, documentation_url: { type: 'string' } } },
        { type: 'object', properties: { message: { type: 'string' }, status: { type: 'string' } } },
      ],
    });
  });

  it('fills required keys that have no property schema', () => {
    valid({ type: 'object', required: ['pageNumber'], properties: { results: { type: 'array', items: { type: 'string' } } } });
  });

  it('honors additionalProperties: false inside allOf', () => {
    valid({ allOf: [{ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'string' } } }] });
  });

  it('prefers the string branch of deep expandable fields (Stripe)', () => {
    const node: any = { type: 'object', required: ['id', 'customer'], properties: { id: { type: 'string' } } };
    node.properties.customer = { anyOf: [{ type: 'string', maxLength: 5000 }, node] };
    valid(node, 5);
  });

  it('generates json-pointer and other less common formats', () => {
    valid({ type: 'object', properties: Object.fromEntries(['json-pointer', 'relative-json-pointer', 'uri-template', 'regex', 'iri-reference'].map((f) => [f, { type: 'string', format: f }])) });
  });
});

describe('mergeAllOf', () => {
  it('narrows enums and bounds instead of keeping the first member', async () => {
    const { mergeAllOf } = await import('../src/schema.js');
    expect(mergeAllOf({ allOf: [{ enum: ['a', 'b', 'c'], minLength: 1 }, { enum: ['b', 'c', 'd'], minLength: 3 }] })).toMatchObject({ enum: ['b', 'c'], minLength: 3 });
  });
});
