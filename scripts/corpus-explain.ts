// Explain why a corpus response fails validation: every leaf error with the exact
// subschema and value it applies to, including errors inside each oneOf/anyOf branch.
//
//   npm run corpus:explain -- linode "GET /linode/instances" 200 [seed]
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { generate } from '../src/generate.js';
import { loadOpenApi } from '../src/openapi.js';
import { toJsonSchema } from '../src/validate.js';
import { cachePath, readManifest } from './corpus-fetch.js';

const [name, route, status = '200', seedArg = '1'] = process.argv.slice(2);
if (!name || !route) throw new Error('usage: corpus:explain <spec> "<METHOD> <path>" [status] [seed]');
const spec = (await readManifest()).find((s) => s.name === name);
if (!spec) throw new Error(`no corpus spec named ${name}`);

const model = await loadOpenApi(cachePath(spec));
const [method, path] = route.split(' ');
const r = model.routes.find((x) => x.method === method && x.path === path);
const res = r?.responses.find((x) => (x.isDefault ? 'default' : String(x.status)) === status);
if (!res?.schema) throw new Error(`${route} ${status} has no schema`);

const label = `${method} ${path} ${status}`;
const value = generate(res.schema, { seed: Number(seedArg), key: label });
const ajv = new Ajv2020({ strict: false, allErrors: true, verbose: true, logger: false });
(addFormatsModule as unknown as (a: Ajv2020) => void)(ajv);
const validate = ajv.compile(toJsonSchema(res.schema, model.openapi.startsWith('3.0')));
if (validate(value)) {
  console.log(`✔ ${label} (seed ${seedArg}) is valid`);
  process.exit(0);
}

const show = (v: unknown, n = 400) => JSON.stringify(v, (k, x) => (k === 'description' || k === 'title' ? undefined : x))?.slice(0, n);
const leaves = validate.errors!.filter((e) => !['oneOf', 'anyOf', 'if'].includes(e.keyword));
const seen = new Set<string>();
for (const e of leaves) {
  // Collapse array indexes in the data path, but keep branch indexes in the schema path.
  const key = `${e.instancePath.replace(/\/\d+/g, '/*')} ${e.schemaPath} ${e.message}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`\n${e.instancePath || '(root)'}  ${e.message}  ${show(e.params, 120)}`);
  console.log(`  at schema ${e.schemaPath}`);
  console.log(`  value:  ${show(e.data)}`);
  console.log(`  schema: ${show(e.parentSchema)}`);
  if (seen.size >= 20) break;
}
const summaries = validate.errors!.filter((e) => e.keyword === 'oneOf' || e.keyword === 'anyOf');
for (const e of summaries.slice(0, 4)) console.log(`\n${e.instancePath || '(root)'}  ${e.message}  ${show(e.params, 120)}`);
