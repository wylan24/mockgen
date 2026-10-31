import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Hot reload lives in the CLI, so these tests run the real `mockgen serve` against a
// temp copy of a spec, edit files on disk, and wait for the server to reflect it.

const CLI = path.resolve('src/cli.ts');
const TIMEOUT_MS = 10_000;

const spec = (routes: string[]) => `openapi: 3.1.0
info: { title: Reload, version: 1.0.0 }
paths:
${routes.map((r) => `  /${r}:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: './schemas/item.yaml' }`).join('\n')}
`;
const itemSchema = (field: string) => `type: object
required: [id, ${field}]
properties:
  id: { type: integer, minimum: 1 }
  ${field}: { type: string }
`;

interface Running {
  url: string;
  output: () => string;
}

let child: ChildProcess | undefined;
let dir: string;

afterEach(async () => {
  child?.kill();
  child = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function setup(files: Record<string, string>): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mockgen-reload-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

function serve(target: string): Promise<Running> {
  const proc = spawn(process.execPath, ['--import', 'tsx', CLI, 'serve', target, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;
  let out = '';
  // Strip ANSI in case the runner forces color.
  const append = (chunk: Buffer) => (out += chunk.toString().replace(/\x1b\[[0-9;]*m/g, ''));
  proc.stdout!.on('data', append);
  proc.stderr!.on('data', append);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), TIMEOUT_MS);
    proc.on('exit', (code, signal) => {
      out += `\n[server exited: code ${code}, signal ${signal}]\n`;
      reject(new Error(`server exited with ${code}:\n${out}`));
    });
    proc.stdout!.on('data', () => {
      const url = out.match(/Mock server ready at (http:\/\/\S+)/)?.[1];
      if (url) {
        clearTimeout(timer);
        resolve({ url, output: () => out });
      }
    });
  });
}

/** Poll until `check` passes; fs.watch delivery and the 100 ms debounce are asynchronous. */
async function eventually(check: () => Promise<void>, output: () => string) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`${(err as Error).message}\n--- server output ---\n${output()}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

const status = async (url: string) => (await fetch(url)).status;
const json = async (url: string) => (await fetch(url)).json() as Promise<Record<string, unknown>>;

/**
 * Save the way many editors do: write a temp file, then rename it over the original.
 * Windows refuses the rename (EPERM) while the server has the file open mid-reload;
 * editors retry, and so do we.
 */
async function atomicWrite(file: string, content: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content);
  for (let attempt = 1; ; attempt++) {
    try {
      return await fs.rename(tmp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM' || attempt === 20) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

describe('hot reload', { timeout: 30_000 }, () => {
  it('serves a route added to the spec', async () => {
    const root = await setup({ 'openapi.yaml': spec(['items']), 'schemas/item.yaml': itemSchema('name') });
    const { url, output } = await serve(path.join(root, 'openapi.yaml'));
    expect(await status(`${url}/widgets`)).toBe(404);

    await fs.writeFile(path.join(root, 'openapi.yaml'), spec(['items', 'widgets']));
    await eventually(async () => expect(await status(`${url}/widgets`)).toBe(200), output);
    expect(output()).toContain('Reloaded 2 routes');
  });

  it('reloads when a $ref-ed file changes', async () => {
    const root = await setup({ 'openapi.yaml': spec(['items']), 'schemas/item.yaml': itemSchema('name') });
    const { url, output } = await serve(path.join(root, 'openapi.yaml'));
    expect(await json(`${url}/items`)).toHaveProperty('name');

    await fs.writeFile(path.join(root, 'schemas/item.yaml'), itemSchema('title'));
    await eventually(async () => expect(await json(`${url}/items`)).toHaveProperty('title'), output);
  });

  it('keeps serving the last good version while the spec is broken, then recovers', async () => {
    const root = await setup({ 'openapi.yaml': spec(['items']), 'schemas/item.yaml': itemSchema('name') });
    const file = path.join(root, 'openapi.yaml');
    const { url, output } = await serve(file);

    await fs.writeFile(file, 'openapi: 3.1.0\npaths: [unclosed');
    await eventually(async () => expect(output()).toContain('Reload failed, still serving the previous version'), output);
    expect(await status(`${url}/items`)).toBe(200);

    await fs.writeFile(file, spec(['items', 'widgets']));
    await eventually(async () => expect(await status(`${url}/widgets`)).toBe(200), output);
  });

  it('recovers after a broken atomic save (write + rename)', async () => {
    const root = await setup({ 'openapi.yaml': spec(['items']), 'schemas/item.yaml': itemSchema('name') });
    const file = path.join(root, 'openapi.yaml');
    const { url, output } = await serve(file);

    await atomicWrite(file, 'openapi: 3.1.0\npaths: [unclosed');
    await eventually(async () => expect(output()).toContain('Reload failed'), output);
    expect(await status(`${url}/items`)).toBe(200);

    await atomicWrite(file, spec(['items', 'widgets']));
    await eventually(async () => expect(await status(`${url}/widgets`)).toBe(200), output);
  });

  it('picks up a new file in a sample folder', async () => {
    const root = await setup({ 'GET.users.json': JSON.stringify([{ id: 1, name: 'Ada' }]) });
    const { url, output } = await serve(root);
    expect(await status(`${url}/teams`)).toBe(404);

    await fs.writeFile(path.join(root, 'GET.teams.json'), JSON.stringify([{ id: 1, title: 'Core' }]));
    await eventually(async () => expect(await status(`${url}/teams`)).toBe(200), output);
  });
});
