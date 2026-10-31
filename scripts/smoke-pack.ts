// Install the package the way a user does — `npm pack`, then a production-only
// install into an empty project — and run the CLI and library from there. This
// catches what the test suite can't: files missing from the tarball, or runtime
// imports listed under devDependencies.
//
//   npm run smoke
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mockgen-smoke-'));
const run = (cmd: string, cwd = work) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  const tarball = path.join(work, JSON.parse(run(`npm pack --json --pack-destination "${work}"`, root))[0].filename);
  const app = path.join(work, 'app');
  await fs.mkdir(app);
  run('npm init -y', app);
  run(`npm install --omit=dev --no-audit --no-fund "${tarball}"`, app);

  const bin = path.join(app, 'node_modules', '@wylan24', 'mockgen', 'dist', 'cli.js');
  const cli = (...args: string[]) => execFileSync(process.execPath, [bin, ...args], { cwd: app, encoding: 'utf8' });
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const checks: [string, () => void][] = [
    ['--version', () => assert(cli('--version').trim() === version, 'wrong version')],
    ['validate an OpenAPI spec', () => assert(/✔/.test(cli('validate', path.join(root, 'examples', 'petstore.yaml'))), 'validate failed')],
    ['validate a sample folder', () => assert(/✔/.test(cli('validate', path.join(root, 'examples', 'samples'))), 'validate failed')],
    ['generate', () => assert(JSON.parse(cli('generate', path.join(root, 'examples', 'petstore.yaml'), 'GET /users/7')).id === 7, 'wrong id')],
    ['npm bin shim', () => assert(/^\d/.test(run('npx --no-install mockgen --version', app)), 'npx failed')],
  ];

  // The library entry point, imported by package name from the installed copy.
  const lib = path.join(app, 'lib.mjs');
  await fs.writeFile(
    lib,
    `import { createMockServer } from '@wylan24/mockgen';
const mock = await createMockServer({ spec: ${JSON.stringify(path.join(root, 'examples', 'petstore.yaml'))} });
const url = await mock.listen(0);
const res = await fetch(url + '/users?limit=2');
const body = await res.json();
await mock.close();
if (res.status !== 200 || body.data.length !== 2) throw new Error('unexpected response');
`,
  );
  checks.push(['library import + serve', () => execFileSync(process.execPath, [lib], { cwd: app })]);

  let failed = 0;
  for (const [name, check] of checks) {
    try {
      check();
      console.log(`✔ ${name}`);
    } catch (err) {
      failed++;
      console.error(`✖ ${name}\n${String((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n').slice(0, 6).join('\n')}`);
    }
  }
  if (failed) process.exitCode = 1;
  else console.log(`\nInstalled ${path.basename(tarball)} cleanly and everything ran.`);
} finally {
  await fs.rm(work, { recursive: true, force: true });
}

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
