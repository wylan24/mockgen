import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { generate } from '../src/generate.js';
import { loadOpenApi } from '../src/openapi.js';

const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);

const user = {
  type: 'object',
  required: ['id', 'firstName', 'lastName', 'email', 'createdAt'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    email: { type: 'string', format: 'email' },
    avatarUrl: { type: 'string', format: 'uri' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

describe('generate', () => {
  it('is deterministic for the same seed and key', () => {
    const a = generate(user, { seed: 7, key: 'GET /users/1' });
    const b = generate(user, { seed: 7, key: 'GET /users/1' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('varies with seed and key', () => {
    const a = JSON.stringify(generate(user, { seed: 1, key: 'k' }));
    expect(JSON.stringify(generate(user, { seed: 2, key: 'k' }))).not.toBe(a);
    expect(JSON.stringify(generate(user, { seed: 1, key: 'other' }))).not.toBe(a);
  });

  it('produces coherent people: email matches the name', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const u = generate(user, { seed }) as any;
      const first = u.firstName.toLowerCase().replace(/[^a-z]/g, '');
      expect(u.email.replace(/[^a-z@]/g, '')).toContain(first.slice(0, 3));
      expect(u.avatarUrl).toMatch(/^https:\/\//);
    }
  });

  it('pins dates so output never drifts with the clock', () => {
    const v = generate({ type: 'string', format: 'date-time' }, { seed: 3 }) as string;
    expect(new Date(v).getTime()).toBeLessThanOrEqual(Date.parse('2026-01-01T00:00:00Z'));
  });

  it('prefers schema examples', () => {
    expect(generate({ type: 'string', example: 'Biscuit' })).toBe('Biscuit');
    expect(generate({ type: 'object', properties: { n: { type: 'integer', examples: [42] } } })).toEqual({ n: 42 });
  });

  const constraintCases: [string, object][] = [
    ['enum', { type: 'string', enum: ['a', 'b', 'c'] }],
    ['const', { const: 'fixed' }],
    ['integer bounds', { type: 'integer', minimum: 10, maximum: 12 }],
    ['3.1 exclusive bounds', { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 }],
    ['multipleOf', { type: 'integer', minimum: 0, maximum: 100, multipleOf: 5 }],
    ['string length', { type: 'string', minLength: 20, maxLength: 25 }],
    ['pattern', { type: 'string', pattern: '^[A-Z]{3}-\\d{4}$' }],
    ['array bounds', { type: 'array', minItems: 4, maxItems: 4, items: { type: 'string', format: 'uuid' } }],
    ['unique items', { type: 'array', uniqueItems: true, minItems: 2, items: { type: 'integer', minimum: 1, maximum: 50 } }],
    ['nullable 3.1', { type: ['string', 'null'], maxLength: 5 }],
    ['oneOf', { oneOf: [{ type: 'string', format: 'email' }, { type: 'integer', minimum: 0 }] }],
    ['allOf', { allOf: [user, { type: 'object', required: ['role'], properties: { role: { enum: ['admin', 'member'] } } }] }],
    ['additionalProperties', { type: 'object', additionalProperties: { type: 'integer', minimum: 0, maximum: 9 } }],
    ['price with bounds', { type: 'object', properties: { price: { type: 'number', minimum: 5000, maximum: 5001 } } }],
    ['formats', {
      type: 'object',
      properties: Object.fromEntries(
        ['date', 'date-time', 'time', 'email', 'uri', 'uuid', 'ipv4', 'ipv6', 'hostname'].map((f) => [f, { type: 'string', format: f }]),
      ),
    }],
  ];

  it.each(constraintCases)('honors %s across seeds', (_, schema) => {
    const validate = ajv.compile(schema);
    for (let seed = 1; seed <= 50; seed++) {
      const value = generate(schema, { seed });
      expect(validate(value), `seed ${seed}: ${JSON.stringify(value)} ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it('terminates on circular schemas', () => {
    const node: any = { type: 'object', properties: { name: { type: 'string' } } };
    node.properties.children = { type: 'array', items: node };
    expect(() => generate(node, { seed: 1 })).not.toThrow();
  });
});

describe('example spec', () => {
  it('every response in examples/petstore.yaml validates against its schema', async () => {
    const model = await loadOpenApi('examples/petstore.yaml');
    let checked = 0;
    for (const route of model.routes) {
      for (const res of route.responses) {
        if (!res.schema) continue;
        const validate = ajv.compile(res.schema);
        for (let seed = 1; seed <= 20; seed++) {
          const value = generate(res.schema, { seed, key: `${route.method} ${route.path}` });
          expect(validate(value), `${route.method} ${route.path} ${res.status}: ${ajv.errorsText(validate.errors)}`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('name heuristics', () => {
  const nameIn = (owner: string) => {
    const schema = { type: 'object', properties: { [owner]: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } } } };
    return (generate(schema, { seed: 4 }) as any)[owner].name as string;
  };

  it('names a record by what it is', () => {
    const person = (generate({ type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } } }, { seed: 4 }) as any).name;
    expect(person).toMatch(/^\S+ \S+/);
    expect(nameIn('company')).not.toBe(nameIn('author'));
    expect(nameIn('project')).toMatch(/^[a-z]+(-[a-z]+)+$/);
  });
});

describe('titles and signed numbers', () => {
  const titleIn = (props: Record<string, object>, seed = 1) =>
    (generate({ type: 'object', required: ['title', ...Object.keys(props)], properties: { title: { type: 'string' }, ...props } }, { seed }) as { title: string }).title;

  it('gives titles that fit the record instead of placeholder Latin', () => {
    const task = titleIn({ status: { type: 'string' }, assignee: { type: 'string' } });
    expect(task).toMatch(/^[A-Z][a-z-]+ [a-z-]+ [a-z-]+$/); // "Calculate optical protocol"
    expect(task).not.toMatch(/\b(lorem|ipsum|dolor|amet)\b/i);
    expect(titleIn({ price: { type: 'number' } })).not.toBe(task);
    expect(titleIn({ isbn: { type: 'string' } })).not.toBe(task);
  });

  it('lets naturally signed numbers go negative', () => {
    const values = (name: string) =>
      Array.from({ length: 40 }, (_, seed) => (generate({ type: 'object', required: [name], properties: { [name]: { type: 'number' } } }, { seed }) as Record<string, number>)[name]!);
    for (const name of ['balance', 'latitude', 'temperatureCelsius', 'priceChange']) expect(values(name).some((v) => v < 0), name).toBe(true);
    expect(values('price').every((v) => v >= 0)).toBe(true);
  });

  it('keeps signed numbers within the schema', () => {
    for (let seed = 0; seed < 40; seed++) {
      const { balance } = generate({ type: 'object', required: ['balance'], properties: { balance: { type: 'integer', minimum: 0 } } }, { seed }) as { balance: number };
      expect(balance).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('boolean schemas', () => {
  it('treats true as anything and leaves out properties whose schema is false', () => {
    const value = generate({ type: 'object', required: ['a'], properties: { a: { type: 'integer' }, b: false, c: true } } as never, { seed: 1 }) as Record<string, unknown>;
    expect(value).toHaveProperty('a');
    expect(value).not.toHaveProperty('b');
    expect(() => generate(false as never)).not.toThrow();
  });
});
