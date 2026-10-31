import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { availableLocales, createMockServer, generate, loadSource, respond } from '../src/index.js';

const user = {
  type: 'object',
  properties: { firstName: { type: 'string' }, lastName: { type: 'string' }, email: { type: 'string', format: 'email' }, city: { type: 'string' } },
};

describe('locales', () => {
  it('lists the locales Faker ships', () => {
    const locales = availableLocales();
    expect(locales).toEqual(expect.arrayContaining(['en', 'de', 'ja', 'pt_BR']));
    expect(locales).not.toContain('base');
  });

  it('is deterministic per locale and differs between locales', () => {
    const de = generate(user, { seed: 1, key: 'u', locale: 'de' });
    expect(generate(user, { seed: 1, key: 'u', locale: 'de' })).toEqual(de);
    expect(generate(user, { seed: 1, key: 'u', locale: 'fr' })).not.toEqual(de);
  });

  it('defaults to English, unaffected by an earlier locale', () => {
    const en = generate(user, { seed: 1, key: 'u' });
    generate(user, { seed: 1, key: 'u', locale: 'ja' });
    expect(generate(user, { seed: 1, key: 'u' })).toEqual(en);
    expect(generate(user, { seed: 1, key: 'u', locale: 'en' })).toEqual(en);
  });

  it('rejects an unknown locale with the list of valid ones', () => {
    expect(() => generate(user, { locale: 'xx' })).toThrow(/Unknown locale "xx"\. Available: .*\bde\b/);
  });

  it('localizes served responses, and list items still match their detail route', async () => {
    const model = await loadSource('examples/petstore.yaml');
    const list = respond(model, { method: 'GET', path: '/users', seed: 1, locale: 'de', query: 'limit=10' }).body as { data: { id: number }[] };
    const item = list.data.find((u) => u.id === 7)!;
    expect(respond(model, { method: 'GET', path: '/users/7', seed: 1, locale: 'de' }).body).toEqual(item);
    expect(respond(model, { method: 'GET', path: '/users/7', seed: 1 }).body).not.toEqual(item);
  });

  it('pins localized output on every OS', async () => {
    const model = await loadSource('examples/petstore.yaml');
    const out = Object.fromEntries(['de', 'ja', 'pt_BR'].map((locale) => [locale, respond(model, { method: 'GET', path: '/users/7', seed: 1, locale }).body]));
    await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot('__snapshots__/locales.served.json');
  });

  it('createMockServer rejects an unknown locale up front', async () => {
    await expect(createMockServer({ spec: 'examples/petstore.yaml', locale: 'xx' })).rejects.toThrow(/Unknown locale "xx"/);
  });

  it('the CLI explains an unknown --locale', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'generate', 'examples/petstore.yaml', '--locale', 'xx'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Unknown locale "xx"');
  });
});
