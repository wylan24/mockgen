#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { assertLocale, generate } from './generate.js';
import type { MockModel } from './model.js';
import { loadSource } from './load.js';
import { formatOpenApi, loadSamples } from './samples.js';
import { checkOverrides, findConfig, loadConfig, normalizeRoutes, type RouteOverride } from './config.js';
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
  -H, --host <host>   Host to bind (default 127.0.0.1, or $MOCKGEN_HOST if set)
  -s, --seed <n>      Seed for generated data (default 1)
  -d, --delay <ms>    Delay every response, e.g. 300 or 300ms
  -r, --records <n>   Records per list endpoint, paged with ?page=&limit= (default 50)
  -l, --locale <code> Language and region for names, addresses and text, e.g. de, ja,
                      pt_BR (default en)
  -o, --out <file>    infer: write here instead of stdout (.yaml or .json)
      --stateful      Remember changes: POST creates, PUT/PATCH update, DELETE removes
                      (reset with POST /__mockgen/reset)
      --validate-requests
                      Check requests against the spec; invalid ones get a 400/422 and
                      an X-Mock-Validation header saying what's wrong
  -c, --config <file> Config file (default: mock.config.{ts,mts,js,mjs,json} in this
                      folder, if there is one). Flags override its options.
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
    // No defaults here: an unset flag falls back to the config file, then to the default.
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'H' },
      seed: { type: 'string', short: 's' },
      delay: { type: 'string', short: 'd' },
      out: { type: 'string', short: 'o' },
      records: { type: 'string', short: 'r' },
      locale: { type: 'string', short: 'l' },
      config: { type: 'string', short: 'c' },
      watch: { type: 'boolean', default: true },
      stateful: { type: 'boolean' },
      'validate-requests': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.version) return console.log(await version());
  const [command, spec, ...rest] = positionals;
  if (values.help || !command) return console.log(HELP);
  if (!spec) fail(`Missing <spec>. Try: mockgen ${command} ./openapi.yaml`);
  if (command === 'infer') return infer(spec, values.out);
  if (!['serve', 'generate', 'validate'].includes(command)) fail(`Unknown command "${command}". Run mockgen --help.`);

  const configFile = values.config ?? findConfig();
  const config = configFile ? await loadConfig(configFile).catch((err: Error) => fail(err.message)) : {};
  const opts: Options = {
    port: values.port !== undefined ? int(values.port, '--port') : (config.port ?? 4010),
    host: values.host ?? config.host ?? (process.env.MOCKGEN_HOST || '127.0.0.1'),
    seed: values.seed !== undefined ? int(values.seed, '--seed') : (config.seed ?? 1),
    delay: values.delay !== undefined ? int(values.delay.replace(/ms$/, ''), '--delay') : (config.delay ?? 0),
    records: values.records !== undefined ? int(values.records, '--records') : (config.records ?? 50),
    locale: values.locale ?? config.locale,
    stateful: values.stateful ?? config.stateful ?? false,
    validateRequests: values['validate-requests'] ?? config.validateRequests ?? false,
    watch: values.watch,
    configFile,
    overrides: normalizeRoutes(config.routes),
  };
  if (opts.locale) {
    try {
      assertLocale(opts.locale);
    } catch (err) {
      fail((err as Error).message);
    }
  }
  if (command === 'serve') return serve(spec, opts);
  if (command === 'generate') return generateCmd(spec, rest.join(' '), opts);
  return validate(spec, opts);
}

interface Options {
  port: number;
  host: string;
  seed: number;
  delay: number;
  records: number;
  locale?: string;
  stateful: boolean;
  validateRequests: boolean;
  watch: boolean;
  configFile?: string;
  overrides: Record<string, RouteOverride>;
}

/** Load the spec and check the config's route overrides against it; `errors` are fatal. */
async function loadWithOverrides(spec: string, overrides: Record<string, RouteOverride>) {
  const model = await loadSource(spec);
  return { model, ...checkOverrides(overrides, model) };
}

async function serve(spec: string, opts: Options) {
  const started = performance.now();
  const { model, errors, warnings } = await loadWithOverrides(spec, opts.overrides);
  if (errors.length) fail(errors.join('\n  '));
  printWarnings(model, warnings);
  const mock = createMockServer({ model, seed: opts.seed, delay: opts.delay, records: opts.records, locale: opts.locale, stateful: opts.stateful, validateRequests: opts.validateRequests, overrides: opts.overrides, log: (line) => console.log(styleText('dim', line)) });
  const url = await mock.listen(opts.port, opts.host).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') fail(`Port ${opts.port} is already in use on ${opts.host}. Pick another with --port ${opts.port + 1}, or --port 0 for any free port.`);
    if (err.code === 'EACCES') fail(`No permission to use port ${opts.port} on ${opts.host}. Ports below 1024 usually need admin rights; try --port 4010.`);
    throw err;
  });

  // Watch before announcing "ready": a script that edits the spec as soon as it sees
  // that line would otherwise race the watcher and its edit could be missed.
  // The config file is watched with the spec; either changing reloads both.
  const extra = opts.configFile ? [opts.configFile] : [];
  if (opts.watch) watchSources(model, extra, async () => {
    try {
      const overrides = opts.configFile ? normalizeRoutes((await loadConfig(opts.configFile)).routes) : opts.overrides;
      const { model: next, errors, warnings } = await loadWithOverrides(spec, overrides);
      if (errors.length) throw new Error(errors.join('\n  '));
      mock.setModel(next);
      mock.setOverrides(overrides);
      printWarnings(next, warnings);
      console.log(`${styleText('green', '↻')} Reloaded ${next.routes.length} routes`);
      return next;
    } catch (err) {
      console.error(styleText('red', `✖ Reload failed, still serving the previous version:\n  ${(err as Error).message}`));
      return undefined;
    }
  });

  console.log(`\n${styleText('bold', model.title)} ${styleText('dim', model.version)}`);
  if (opts.configFile) {
    const count = Object.keys(opts.overrides).length;
    console.log(styleText('dim', `  config: ${path.relative(process.cwd(), opts.configFile)}${count ? ` (${count} route override${count === 1 ? '' : 's'})` : ''}`));
  }
  for (const r of model.routes) console.log(`  ${styleText('cyan', r.method.padEnd(7))} ${url}${model.basePath}${r.path}`);
  console.log(`\n${styleText('green', '✔')} Mock server ready at ${styleText('bold', url)} in ${Math.round(performance.now() - started)}ms (seed ${opts.seed}${opts.stateful ? ', stateful' : ''}${opts.validateRequests ? ', validating requests' : ''})\n`);

  const shutdown = () => mock.close().then(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/**
 * Watch the spec's files and reload on change, debounced.
 *
 * Each file is watched through its folder, filtered by name, rather than directly:
 * on Linux and macOS a watcher on a file follows that file, so an editor's save
 * (write a temp file, rename it over the original) would leave it watching a file
 * that no longer exists. A folder watcher sees the rename and keeps working.
 * Sample folders are watched recursively, and any change in them counts.
 */
function watchSources(model: MockModel, extra: string[], reload: () => Promise<MockModel | undefined>) {
  // folder → names of the spec files in it, or 'all' for a sample folder
  const watchers = new Map<string, { watcher: fs.FSWatcher; names: Set<string> | 'all' }>();
  let timer: NodeJS.Timeout | undefined;
  let retry: NodeJS.Timeout | undefined;

  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const next = await reload();
      if (next) watch([...next.sources, ...extra]);
    }, 100);
  };

  const watch = (sources: string[]) => {
    const wanted = new Map<string, Set<string> | 'all'>();
    for (const source of sources) {
      const isDir = fs.statSync(source, { throwIfNoEntry: false })?.isDirectory();
      if (isDir) {
        wanted.set(path.resolve(source), 'all');
      } else {
        const dir = path.dirname(path.resolve(source));
        const names = wanted.get(dir);
        if (names !== 'all') wanted.set(dir, (names ?? new Set()).add(path.basename(source)));
      }
    }
    for (const [dir, entry] of watchers) {
      if (!wanted.has(dir)) {
        entry.watcher.close();
        watchers.delete(dir);
      }
    }
    let failed = false;
    for (const [dir, names] of wanted) {
      const existing = watchers.get(dir);
      if (existing && (existing.names === 'all') === (names === 'all')) {
        existing.names = names;
        continue;
      }
      existing?.watcher.close();
      try {
        const watcher = fs.watch(dir, { recursive: names === 'all' }, (_event, filename) => {
          const current = watchers.get(dir)?.names;
          // Some platforms omit the file name; then any change in the folder counts.
          if (current === 'all' || !filename || current?.has(path.basename(filename.toString()))) onChange();
        });
        // A watcher error (e.g. the folder was deleted) would otherwise crash the server.
        watcher.on('error', () => {
          watcher.close();
          watchers.delete(dir);
          clearTimeout(retry);
          retry = setTimeout(() => watch(sources), 500);
        });
        watchers.set(dir, { watcher, names });
      } catch {
        failed = true; // e.g. the folder doesn't exist right now
      }
    }
    if (failed) {
      clearTimeout(retry);
      retry = setTimeout(() => watch(sources), 500);
    }
  };
  watch([...model.sources, ...extra]);
}

async function generateCmd(spec: string, route: string, { seed, records, locale, overrides }: Options) {
  const { model, errors } = await loadWithOverrides(spec, overrides);
  if (errors.length) fail(errors.join('\n  '));
  if (route) {
    const [method = 'GET', p = '/'] = route.includes(' ') ? route.split(/\s+/) : ['GET', route];
    const [pathname = '/', query] = p.split('?');
    const result = respond(model, { method: method.toUpperCase(), path: pathname, query, seed, records, locale, overrides });
    if (result.status >= 400 && !model.routes.some((r) => r.pattern.test(pathname))) fail((result.body as any).message);
    return console.log(JSON.stringify(result.body, null, 2));
  }
  const out: Record<string, unknown> = {};
  for (const r of model.routes) {
    const res = r.responses.find((x) => x.status >= 200 && x.status < 300) ?? r.responses[0];
    out[`${r.method} ${r.path}`] = res?.hasExample ? res.example : generate(res?.schema, { seed, locale, key: `${r.method} ${r.path} ${res?.status}` });
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

async function validate(spec: string, { seed, locale, overrides }: Options) {
  const { model, errors, warnings } = await loadWithOverrides(spec, overrides);
  if (errors.length) fail(errors.join('\n  '));
  printWarnings(model);
  const validator = new ResponseValidator(model.openapi);
  let responses = 0;
  let skipped = 0;
  // A fixed override body that doesn't match the spec is a failure here, not just a warning.
  const invalid: string[] = [...warnings];
  for (const r of model.routes) {
    for (const res of r.responses) {
      if (!res.schema || res.hasExample) continue;
      const label = `${r.method} ${r.path} ${res.status}`;
      const value = generate(res.schema, { seed, locale, key: label });
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

function printWarnings(model: MockModel, extra: string[] = []) {
  for (const w of [...model.warnings, ...extra]) console.warn(styleText('yellow', `⚠ ${w}`));
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
