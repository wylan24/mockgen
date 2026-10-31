import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockServer, loadOpenApi, SpecLoadError } from '../src/index.js';

const brokenRef = `openapi: 3.1.0
info: { title: Broken, version: 1.0.0 }
paths:
  /items:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: './missing.yaml' }
`;

// One fixture dir inside the repo (paths shown relative) and one outside it (kept absolute).
let inside: string;
let outside: string;

beforeAll(async () => {
  inside = await fs.mkdtemp(path.join('test', '.tmp-errors-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mockgen-errors-'));
  await fs.writeFile(path.join(inside, 'openapi.yaml'), brokenRef);
  await fs.writeFile(path.join(outside, 'openapi.yaml'), brokenRef);
});
afterAll(async () => {
  await fs.rm(inside, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

const loadError = (file: string) =>
  loadOpenApi(file).then(
    () => expect.fail('expected the spec to fail to load'),
    (err: unknown) => err as SpecLoadError,
  );

describe('spec load errors', () => {
  it('shows paths relative to the working directory', async () => {
    const err = await loadError(path.join(inside, 'openapi.yaml'));
    expect(err).toBeInstanceOf(SpecLoadError);
    expect(err.message.toLowerCase()).not.toContain(process.cwd().toLowerCase());
    expect(err.message.toLowerCase()).not.toContain(process.cwd().replace(/\\/g, '/').toLowerCase());
    expect(err.message).toMatch(/^test[\\/]\.tmp-errors-\w+[\\/]openapi\.yaml: /);
    expect(err.message).toMatch(/missing\.yaml/);
    // The ENOENT detail repeated the path a third time.
    expect(err.message).not.toContain(", open '");
    // Library users still get the absolute path.
    expect(path.isAbsolute(err.file)).toBe(true);
  });

  it('keeps paths outside the working directory absolute', async () => {
    const err = await loadError(path.join(outside, 'openapi.yaml'));
    expect(err.message).toContain(path.join(outside, 'openapi.yaml'));
  });
});

describe('serve', () => {
  it('explains a port that is already in use', { timeout: 20_000 }, async () => {
    const blocker = await createMockServer({ spec: 'examples/petstore.yaml' });
    const port = Number(new URL(await blocker.listen(0)).port);
    try {
      const proc = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve', 'examples/petstore.yaml', '--port', String(port), '--no-watch'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => (stderr += d));
      const code = await new Promise((resolve) => proc.on('exit', resolve));
      expect(code).toBe(1);
      expect(stderr).toContain(`Port ${port} is already in use`);
      expect(stderr).toContain('--port 0');
      expect(stderr).not.toContain('EADDRINUSE');
    } finally {
      await blocker.close();
    }
  });
});
