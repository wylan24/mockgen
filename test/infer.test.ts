import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { generate } from '../src/generate.js';
import { inferSchema } from '../src/infer.js';

const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);

describe('inferSchema', () => {
  it('infers primitive types', () => {
    expect(inferSchema('hi')).toEqual({ type: 'string' });
    expect(inferSchema(true)).toEqual({ type: 'boolean' });
    expect(inferSchema(3)).toEqual({ type: 'integer', minimum: 0 });
    expect(inferSchema(-3)).toEqual({ type: 'integer' });
    expect(inferSchema(null)).toEqual({ type: 'null' });
  });

  it('widens integer + float to number', () => {
    expect(inferSchema(1, 2.5)).toEqual({ type: 'number', minimum: 0 });
  });

  it('marks nullable fields with a 3.1 type array', () => {
    expect(inferSchema({ bio: 'x' }, { bio: null }).properties.bio).toEqual({ type: ['string', 'null'] });
  });

  it('only requires keys present in every sample', () => {
    const s = inferSchema({ a: 1, b: 2 }, { a: 3 });
    expect(s.required).toEqual(['a']);
    expect(Object.keys(s.properties)).toEqual(['a', 'b']);
  });

  it('detects string formats only when every value agrees', () => {
    expect(inferSchema('2025-01-14T09:30:00Z').format).toBe('date-time');
    expect(inferSchema('2025-01-14').format).toBe('date');
    expect(inferSchema('2025-02-30').format).toBeUndefined();
    expect(inferSchema('ada@example.com').format).toBe('email');
    expect(inferSchema('https://example.com/a').format).toBe('uri');
    expect(inferSchema('7b1e4c2a-1f0e-4f6a-9d3b-2c8e5a7f9b10').format).toBe('uuid');
    expect(inferSchema('ada@example.com', 'not an email').format).toBeUndefined();
  });

  it('infers enums from a few repeated short values', () => {
    const roles = ['admin', 'member', 'member', 'viewer', 'member', 'admin'].map((role) => ({ role }));
    expect(inferSchema(roles).items.properties.role).toEqual({ type: 'string', enum: ['admin', 'member', 'viewer'] });
  });

  it('does not infer enums from free text or too few samples', () => {
    const names = ['Ada', 'Ada', 'Grace', 'Grace'].map((name) => ({ name }));
    expect(inferSchema(names).items.properties.name).toEqual({ type: 'string' });
    expect(inferSchema({ status: 'active' }).properties.status).toEqual({ type: 'string' });
  });

  it('keeps null in a nullable enum', () => {
    const s = inferSchema(['a', 'a', 'b', 'b', null].map((status) => ({ status })));
    expect(s.items.properties.status).toEqual({ type: ['string', 'null'], enum: ['a', 'b', null] });
  });

  it('merges array items across all arrays', () => {
    const s = inferSchema({ tags: ['a'] }, { tags: [1] }, { tags: [] });
    expect(s.properties.tags.items).toEqual({ anyOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }] });
  });

  it('allows anything for arrays that were always empty', () => {
    expect(inferSchema([])).toEqual({ type: 'array', items: {} });
  });

  const fixtures: [string, unknown[]][] = [
    ['nested objects', [{ user: { id: 1, address: { city: 'Paris', zip: '75001' } } }, { user: { id: 2, address: null } }]],
    ['mixed arrays', [[1, 'two', { three: 3 }, null, [4]]]],
    ['optional + nullable', [{ a: 1, b: null }, { a: 2.5, c: 'x' }, { b: true }]],
    ['paginated list', [{ data: [{ id: 1, at: '2025-01-01T00:00:00Z' }], page: 1, next: null }, { data: [], page: 2, next: 'https://x.io/?p=3' }]],
  ];

  it.each(fixtures)('%s: samples and generated data validate against the inferred schema', (_, samples) => {
    const validate = ajv.compile(inferSchema(...samples));
    for (const sample of samples) expect(validate(sample), ajv.errorsText(validate.errors)).toBe(true);
    for (let seed = 1; seed <= 30; seed++) {
      const value = generate(inferSchema(...samples), { seed });
      expect(validate(value), `seed ${seed}: ${JSON.stringify(value)} ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });
});
