// The release gate from the plan: load every real-world spec in corpus/specs.json,
// generate every response, and validate it against its schema.
//
//   npm run corpus                  # all specs
//   npm run corpus -- stripe github # just these
//   npm run corpus -- --seeds 5
//   npm run corpus -- --update-baseline   # after fixing failures, record the new counts
//   npm run corpus -- --strict            # release gate: no failures caused by mockgen
//
// corpus/baseline.json records each spec's known invalid responses and their cause:
// `spec` (the spec itself is unsatisfiable, e.g. identical oneOf branches) or `mockgen`
// (our bug, to fix before 1.0). The run fails when fewer than 95% of specs load or any
// spec does worse than its baseline; with --strict, also while any `mockgen` failure remains.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { generate } from '../src/generate.js';
import { loadOpenApi } from '../src/openapi.js';
import { respond } from '../src/server.js';
import { ResponseValidator } from '../src/validate.js';
import { cachePath, readManifest } from './corpus-fetch.js';

const LOAD_TARGET = 0.95;
const MAX_FAILURES_SHOWN = 8;

interface SpecResult {
  name: string;
  sizeKb: number;
  loaded: boolean;
  error?: string;
  loadMs?: number;
  routes?: number;
  checked: number;
  invalid: number;
  /** Schemas Ajv can't compile (e.g. non-JavaScript regex syntax); not counted either way. */
  uncheckable: number;
  failures: string[];
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { seeds: { type: 'string', default: '3' }, 'update-baseline': { type: 'boolean' }, strict: { type: 'boolean' } },
});
const seeds = Number(values.seeds);

interface BaselineEntry {
  invalid: number;
  cause: 'spec' | 'mockgen';
  note: string;
}
const BASELINE_FILE = path.join(import.meta.dirname, '..', 'corpus', 'baseline.json');
const baseline: Record<string, BaselineEntry> = JSON.parse(await fs.readFile(BASELINE_FILE, 'utf8').catch(() => '{"specs":{}}')).specs;

const manifest = await readManifest();
const specs = positionals.length ? manifest.filter((s) => positionals.includes(s.name)) : manifest;
const results: SpecResult[] = [];
const timings: number[] = [];
let peakRss = 0;

for (const spec of specs) {
  const file = cachePath(spec);
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat) throw new Error(`${spec.name} is not downloaded; run npm run corpus:fetch`);
  const result: SpecResult = { name: spec.name, sizeKb: Math.round(stat.size / 1024), loaded: false, checked: 0, invalid: 0, uncheckable: 0, failures: [] };
  results.push(result);

  const started = performance.now();
  let model;
  try {
    model = await loadOpenApi(file);
  } catch (err) {
    result.error = (err as Error).message.replace(path.resolve(file), spec.name).split('\n')[0];
    report(result);
    continue;
  }
  result.loaded = true;
  result.loadMs = Math.round(performance.now() - started);
  result.routes = model.routes.length;

  const validator = new ResponseValidator(model.openapi);
  const seenKinds = new Set<string>();
  const check = (label: string, schema: object, make: () => unknown) => {
    const t = performance.now();
    const value = make();
    timings.push(performance.now() - t);
    let outcome;
    try {
      outcome = validator.validate(schema, value);
    } catch {
      result.uncheckable++;
      return;
    }
    result.checked++;
    if (!outcome.valid) {
      result.invalid++;
      // Show distinct kinds of failure, not the same one five times.
      const kind = outcome.errors!.replace(/\/\d+(?=\/|\s)/g, '/*');
      if (result.failures.length < MAX_FAILURES_SHOWN && !seenKinds.has(kind)) result.failures.push(`${label}: ${outcome.errors}`);
      seenKinds.add(kind);
    }
  };

  for (const route of model.routes) {
    for (const res of route.responses) {
      if (!res.schema || res.hasExample) continue;
      const label = `${route.method} ${route.path} ${res.isDefault ? 'default' : res.status}`;
      for (let seed = 1; seed <= seeds; seed++) {
        check(label, res.schema, () => generate(res.schema, { seed, key: label }));
      }
    }
    // Also run what the server actually sends, which adds path params and pagination.
    const concrete = route.path.replace(/\{[^}]+\}/g, '1');
    const served = respond(model, { method: route.method, path: concrete, query: 'page=2&limit=3', seed: 1, origin: 'http://localhost' });
    const res = route.responses.find((r) => r.status === served.status && !r.isDefault) ?? route.responses.find((r) => r.isDefault);
    if (res?.schema && !res.hasExample && served.body !== undefined) check(`${route.method} ${concrete}?page=2 (served)`, res.schema, () => served.body);
  }

  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  report(result);
}

function report(r: SpecResult) {
  const status = !r.loaded ? '✖ load' : r.invalid ? '✖' : '✔';
  const detail = !r.loaded ? r.error : `${r.routes} routes, ${r.checked - r.invalid}/${r.checked} valid${r.uncheckable ? `, ${r.uncheckable} uncheckable` : ''}, load ${r.loadMs}ms`;
  console.log(`${status.padEnd(7)} ${r.name.padEnd(28)} ${String(r.sizeKb).padStart(6)} KB  ${detail}`);
  for (const f of r.failures) console.log(`          ${f.slice(0, 300)}`);
}

// Summary
const loaded = results.filter((r) => r.loaded).length;
const checked = results.reduce((n, r) => n + r.checked, 0);
const invalid = results.reduce((n, r) => n + r.invalid, 0);
const uncheckable = results.reduce((n, r) => n + r.uncheckable, 0);
const sorted = [...timings].sort((a, b) => a - b);
const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)]! : 0;
const loadRate = loaded / results.length;

const regressions = results
  .filter((r) => !r.loaded || r.invalid > (baseline[r.name]?.invalid ?? 0))
  .map((r) => (r.loaded ? `${r.name}: ${r.invalid} invalid (baseline ${baseline[r.name]?.invalid ?? 0})` : `${r.name}: failed to load`));
const improved = results.filter((r) => r.loaded && r.invalid < (baseline[r.name]?.invalid ?? 0)).map((r) => r.name);
const specBugs = results.reduce((n, r) => n + (baseline[r.name]?.cause === 'spec' ? Math.min(r.invalid, baseline[r.name]!.invalid) : 0), 0);
const ours = results.filter((r) => r.invalid > 0 && baseline[r.name]?.cause !== 'spec');
const passed = loadRate >= LOAD_TARGET && regressions.length === 0 && (!values.strict || ours.length === 0);

const summary = [
  `Specs loaded: ${loaded}/${results.length} (${(loadRate * 100).toFixed(1)}%, target ${LOAD_TARGET * 100}%)`,
  `Responses valid: ${checked - invalid}/${checked} (${checked ? (((checked - invalid) / checked) * 100).toFixed(2) : 100}%, target 100%)${uncheckable ? `; ${uncheckable} uncheckable` : ''}`,
  `Valid excluding known spec bugs: ${checked - invalid}/${checked - specBugs} (${(((checked - invalid) / Math.max(1, checked - specBugs)) * 100).toFixed(2)}%); mockgen failures in ${ours.length} specs${ours.length ? ` (${ours.map((r) => r.name).join(', ')})` : ''}`,
  `Generation p95: ${p95.toFixed(2)}ms per response`,
  `Peak RSS: ${Math.round(peakRss / 1024 / 1024)} MB`,
];
console.log(`\n${summary.join('\n')}`);
for (const r of regressions) console.log(`✖ regression: ${r}`);
if (improved.length && !values['update-baseline']) console.log(`↑ better than baseline: ${improved.join(', ')} (run with --update-baseline)`);
console.log(passed ? '✔ Corpus gate passed' : '✖ Corpus gate failed');

if (values['update-baseline']) {
  const next: Record<string, BaselineEntry> = {};
  for (const r of results) {
    if (r.invalid) next[r.name] = { invalid: r.invalid, cause: baseline[r.name]?.cause ?? 'mockgen', note: baseline[r.name]?.note ?? 'TODO: diagnose' };
  }
  // Keep entries for specs not in this run (e.g. a filtered run).
  for (const [name, entry] of Object.entries(baseline)) if (!results.some((r) => r.name === name)) next[name] = entry;
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(BASELINE_FILE, `${JSON.stringify({ $comment: 'Known invalid responses per spec. See scripts/corpus.ts.', specs: sorted }, null, 2)}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), BASELINE_FILE)}`);
}

await fs.writeFile(
  path.join(import.meta.dirname, '..', 'corpus', 'report.json'),
  JSON.stringify({ loadRate, checked, invalid, uncheckable, p95Ms: p95, peakRssMb: Math.round(peakRss / 1024 / 1024), results }, null, 2),
);
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => `| ${r.loaded ? (r.invalid ? '✖' : '✔') : '✖ load'} | ${r.name} | ${r.sizeKb} KB | ${r.loaded ? `${r.checked - r.invalid}/${r.checked}` : r.error} | ${r.loadMs ?? ''} |`);
  await fs.appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Spec corpus\n\n${summary.map((s) => `- ${s}`).join('\n')}\n\n| | Spec | Size | Valid responses | Load ms |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`,
  );
}
process.exit(passed ? 0 : 1);
