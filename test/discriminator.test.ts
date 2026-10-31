import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate } from '../src/generate.js';
import { loadOpenApi } from '../src/openapi.js';
import { fits, mergeAllOf } from '../src/schema.js';
import { ResponseValidator } from '../src/validate.js';

async function loadSpec(components: object, schema: object) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mockgen-'));
  const file = path.join(dir, 'spec.json');
  const doc = {
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    paths: { '/x': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema } } } } } } },
    components: { schemas: components },
  };
  await fs.writeFile(file, JSON.stringify(doc));
  const model = await loadOpenApi(file);
  await fs.rm(dir, { recursive: true });
  return model.routes[0]!.responses[0]!.schema!;
}

// Branches that differ only by discriminator value, as in Rebilly's kyc-documents:
// every branch's `kind` enum allows every value, so plain JSON Schema sees overlap.
const kinds = { type: 'string', enum: ['card', 'bank'] };
const components = {
  Card: { type: 'object', required: ['kind', 'last4'], properties: { kind: kinds, last4: { type: 'string', pattern: '^\\d{4}$' } } },
  Bank: { type: 'object', required: ['kind'], properties: { kind: kinds, iban: { type: 'string' } } },
};

describe('discriminators', () => {
  it('picks the branch from the mapping and sets the value', async () => {
    const schema = await loadSpec(components, {
      oneOf: [{ $ref: '#/components/schemas/Card' }, { $ref: '#/components/schemas/Bank' }],
      discriminator: { propertyName: 'kind', mapping: { card: '#/components/schemas/Card', bank: '#/components/schemas/Bank' } },
    });
    const validator = new ResponseValidator('3.0.3');
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const value = generate(schema, { seed }) as any;
      seen.add(value.kind);
      if (value.kind === 'card') expect(value.last4).toMatch(/^\d{4}$/);
      expect(validator.validate(schema, value).valid).toBe(true);
      expect(fits(value, schema)).toBe(true);
    }
    expect(seen).toEqual(new Set(['card', 'bank']));
    // A card without last4 is invalid even though it would pass the Bank branch.
    expect(validator.validate(schema, { kind: 'card' }).valid).toBe(false);
    expect(fits({ kind: 'card' }, schema)).toBe(false);
  });

  it('uses a branch\'s single pinned value when there is no explicit mapping (Spotify)', async () => {
    const schema = await loadSpec(
      {
        Track: { type: 'object', properties: { type: { type: 'string', enum: ['track'] }, isrc: { type: 'string' } } },
        Episode: { type: 'object', properties: { type: { type: 'string', enum: ['episode'] }, show: { type: 'string' } } },
      },
      { oneOf: [{ $ref: '#/components/schemas/Track' }, { $ref: '#/components/schemas/Episode' }], discriminator: { propertyName: 'type' } },
    );
    const validator = new ResponseValidator('3.0.3');
    for (let seed = 1; seed <= 10; seed++) {
      const value = generate(schema, { seed }) as any;
      expect(['track', 'episode']).toContain(value.type);
      expect(validator.validate(schema, value).valid).toBe(true);
    }
  });
});

describe('allOf and nullable semantics', () => {
  it('a property defined by two members must satisfy both (Linode backups)', () => {
    const merged = mergeAllOf({
      allOf: [
        { type: 'object', properties: { type: { type: 'string', enum: ['auto', 'snapshot'] } } },
        { type: 'object', properties: { type: { type: 'string', example: 'automatic' } } },
      ],
    });
    for (let seed = 1; seed <= 10; seed++) expect(['auto', 'snapshot']).toContain((generate(merged, { seed }) as any).type);
  });

  it('keeps required properties even when a closed member would drop them', () => {
    const merged = mergeAllOf({
      allOf: [{ additionalProperties: false, type: 'object' }, { type: 'object', required: ['code'], properties: { code: { type: 'string', enum: ['a'] } } }],
    });
    expect(merged.properties.code).toEqual({ type: 'string', enum: ['a'] });
  });

  it('3.0 nullable does not let null skip oneOf (Rebilly ready-to-pay)', () => {
    const schema = { type: 'object', nullable: true, oneOf: [{ type: 'object', properties: { name: { type: 'string' } } }] };
    expect(fits(null, schema)).toBe(false);
    expect(fits(null, { type: 'string', nullable: true })).toBe(true);
    expect(fits(null, { type: 'string', enum: ['a'], nullable: true })).toBe(true);
    expect(fits(null, { allOf: [{ type: 'object' }], nullable: true })).toBe(true);
  });
});
