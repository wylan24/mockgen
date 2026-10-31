#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { generate } from './generate.js';
import type { MockModel } from './model.js';
import { loadSource } from './load.js';
import { formatOpenApi, loadSamples } from './samples.js';
import { createMockServer, respond } from './server.js';
import { ResponseValidator } from './validate.js';

const HELP = `mockgen — turn an OpenAPI spec or a folder of sample responses into a running mock server

Usage
  mockgen serve <spec|dir>             Start a mock server (hot-reloads on change)
  mockgen generate <spec|dir> [route]  Print generated responses, e.g. "GET /users/1"
  mockgen validate <spec|dir>          Load the input and generate every response
  mockgen infer <dir> [-o file]        Write the schema inferred from samples as OpenAPI 3.1

Sample folders: name files after the route, e.g. GET.users.json, users/GET.[id].json,
GET.users.[id].404.json. Folders become path segments; [id] or {id} is a path param.

Options
  -p, --port <n>      Port to listen on (default 4010)
  -H, --host <host>   Host to bind (default 127.0.0.1)
  -s, --seed <n>      Seed for generated data (default 1)
  -d, --delay <ms>    Delay every response, e.g. 300 or 300ms
  -r, --records <n>   Records per list endpoint, paged with ?page=&limit= (default 50)
  -o, --out <file>    infer: write here instead of stdout (.yaml or .json)
      --no-watch      Disable hot reload
  -h, --help          Show this help
  -v, --version       Show the version

Per request
  X-Mock-Status: 404  (or ?__status=404)   Return that status instead of the success response
  X-Mock-Delay: 500   (or ?__delay=500)    Delay this response
  ?page=2&limit=20, ?offset=40, ?cursor=…  Page through list endpoints
`;

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      port: { type: 'string', short: 'p', default: '4010' },
      host: { type: 'string', short: 'H', default: '127.0.0.1' },
      seed: { type: 'string', short: 's', default: '1' },
      delay: { type: 'string', short: 'd', default: '0' },
      out: { type: 'string', short: 'o' },
      records: { type: 'string', short: 'r', default: '50' },
      watch: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.version) return console.log(await version());
  const [command, spec, ...rest] = positionals;
  if (values.help || !command) return console.log(HELP);
  if (!spec) fail(`Missing <spec>. Try: mockgen ${command} ./openapi.yaml`);

  const seed = int(values.seed, '--seed');
  switch (command) {
    case 'serve':
      return serve(spec, { port: int(values.port, '--port'), host: values.host, seed, delay: int(values.delay.replace(/ms$/, ''), '--delay'), watch: values.watch, records: int(values.records, '--records') });
    case 'generate':
      return generateCmd(spec, rest.join(' '), seed, int(values.records, '--records'));
    case 'validate':
      return validate(spec, seed);
    case 'infer':
      return infer(spec, values.out);
    default:
      fail(`Unknown command "${command}". Run mockgen --help.`);
  }
}

async function serve(spec: string, opts: { port: number; host: string; seed: number; delay: number; watch: boolean; records: number }) {
  const started = performance.now();
  const model = await loadSource(spec);
  printWarnings(model);
  const mock = createMockServer({ model, seed: opts.seed, delay: opts.delay, records: opts.records, log: (line) => console.log(styleText('dim', line)) });
  const url = await mock.listen(opts.port, opts.host).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') fail(`Port ${opts.port} is already in use on ${opts.host}. Pick another with --port ${opts.port + 1}, or --port 0 for any free port.`);
    if (err.code === 'EACCES') fail(`No permission to use port ${opts.port} on ${opts.host}. Ports below 1024 usually need admin rights; try --port 4010.`);
    throw err;
  });

  console.log(`\n${styleText('bold', model.title)} ${styleText('dim', model.version)}`);
  for (const r of model.routes) console.log(`  ${styleText('cyan', r.method.padEnd(7))} ${url}${model.basePath}${r.path}`);
  console.log(`\n${styleText('green', '✔')} Mock server ready at ${styleText('bold', url)} in ${Math.round(performance.now() - started)}ms (seed ${opts.seed})\n`);

  if (opts.watch) watchSources(model, async () => {
    try {
      const next = await loadSource(spec);
      mock.setModel(next);
      printWarnings(next);
      console.log(`${styleText('green', '↻')} Reloaded ${next.routes.length} routes`);
      return next;
    } catch (err) {
      console.error(styleText('red', `✖ Reload failed, still serving the previous version:\n  ${(err as Error).message}`));
      return undefined;
    }
  });

  const shutdown = () => mock.close().then(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/** Watch every local file of the spec and reload on change, debounced. */
function watchSources(model: MockModel, reload: () => Promise<MockModel | undefined>) {
  let watchers: fs.FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  const watch = (files: string[]) => {
    watchers.forEach((w) => w.close());
    watchers = files.map((file) =>
      fs.watch(file, { recursive: fs.statSync(file).isDirectory() }, () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const next = await reload();
          if (next) watch(next.sources);
        }, 100);
      }),
    );
  };
  watch(model.sources);
}

async function generateCmd(spec: string, route: string, seed: number, records: number) {
  const model = await loadSource(spec);
  if (route) {
    const [method = 'GET', p = '/'] = route.includes(' ') ? route.split(/\s+/) : ['GET', route];
    const [pathname = '/', query] = p.split('?');
    const result = respond(model, { method: method.toUpperCase(), path: pathname, query, seed, records });
    if (result.status >= 400 && !model.routes.some((r) => r.pattern.test(pathname))) fail((result.body as any).message);
    return console.log(JSON.stringify(result.body, null, 2));
  }
  const out: Record<string, unknown> = {};
  for (const r of model.routes) {
    const res = r.responses.find((x) => x.status >= 200 && x.status < 300) ?? r.responses[0];
    out[`${r.method} ${r.path}`] = res?.hasExample ? res.example : generate(res?.schema, { seed, key: `${r.method} ${r.path} ${res?.status}` });
  }
  console.log(JSON.stringify(out, null, 2));
}

async function infer(dir: string, out: string | undefined) {
  if (!(await fs.promises.stat(dir).catch(() => undefined))?.isDirectory()) fail(`infer expects a folder of sample responses, got "${dir}"`);
  const model = await loadSamples(dir);
  printWarnings(model);
  const text = formatOpenApi(model, out);
  if (!out) return process.stdout.write(text);
  await fs.promises.writeFile(out, text);
  console.error(`${styleText('green', '✔')} Wrote ${model.routes.length} routes to ${out}`);
}

async function validate(spec: string, seed: number) {
  const model = await loadSource(spec);
  printWarnings(model);
  const validator = new ResponseValidator(model.openapi);
  let responses = 0;
  let skipped = 0;
  const invalid: string[] = [];
  for (const r of model.routes) {
    for (const res of r.responses) {
      if (!res.schema || res.hasExample) continue;
      const label = `${r.method} ${r.path} ${res.status}`;
      const value = generate(res.schema, { seed, key: label });
      try {
        const result = validator.validate(res.schema, value);
        if (!result.valid) invalid.push(`${label}: ${result.errors}`);
        responses++;
      } catch {
        skipped++; // The schema itself can't be compiled (e.g. a non-JavaScript regex).
      }
    }
  }
  for (const line of invalid) console.error(styleText('red', `✖ ${line}`));
  const summary = `${model.title}: ${model.routes.length} routes, ${responses - invalid.length}/${responses} generated responses valid${skipped ? `, ${skipped} schemas not checkable` : ''}, ${model.warnings.length} warnings`;
  if (invalid.length) fail(summary);
  console.log(`${styleText('green', '✔')} ${summary}`);
}

function printWarnings(model: MockModel) {
  for (const w of model.warnings) console.warn(styleText('yellow', `⚠ ${w}`));
}

function int(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(`${flag} must be a non-negative integer, got "${value}"`);
  return n;
}

async function version(): Promise<string> {
  const pkg = JSON.parse(await fs.promises.readFile(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  return pkg.version;
}

function fail(message: string): never {
  console.error(styleText('red', `✖ ${message}`));
  process.exit(1);
}

main(process.argv.slice(2)).catch((err) => fail(err.message));
