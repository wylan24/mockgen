import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { SchemaInferrer } from './infer.js';
import type { MockModel, MockResponse, MockRoute } from './model.js';
import { compilePath, METHODS, sortRoutes } from './openapi.js';

// A sample folder maps file names to routes:
//
//   GET.users.json                → GET /users
//   GET.users.[id].json           → GET /users/{id}     ({id} works too)
//   users/GET.[id].json           → GET /users/{id}     (folders are path segments)
//   GET.users.[id].404.json       → the 404 response of GET /users/{id}
//   GET.users.[id]~alice.json     → another sample for the same response
//   DELETE.users.[id].json        → empty file = no body (204)
//
// All samples for one route + status are merged into one inferred schema.

export interface ParsedSampleName {
  method: string;
  path: string;
  status?: number;
}

/** Parse a sample file's path (relative to the sample folder) into a route; undefined if it isn't one. */
export function parseSampleName(relative: string): ParsedSampleName | undefined {
  const parts = relative.split(/[\\/]/).filter(Boolean);
  const file = parts.pop();
  if (!file?.toLowerCase().endsWith('.json')) return undefined;

  const tokens = file.slice(0, -'.json'.length).replace(/~[^.]*$/, '').split('.');
  const method = tokens.shift()!.toLowerCase();
  if (!(METHODS as readonly string[]).includes(method)) return undefined;

  let status: number | undefined;
  if (tokens.length && /^[1-5]\d\d$/.test(tokens.at(-1)!)) status = Number(tokens.pop());

  const segments = [...parts, ...tokens].map((seg) => seg.replace(/^\[([^\]]+)\]$/, '{$1}'));
  if (segments.some((s) => s === '')) return undefined;
  return { method: method.toUpperCase(), path: `/${segments.join('/')}`, status };
}

/** Load a folder of sample JSON responses into the normalized model. */
export async function loadSamples(dir: string): Promise<MockModel> {
  const root = path.resolve(dir);
  const warnings: string[] = [];
  // route key → status → { inferrer, empty }
  const groups = new Map<string, { method: string; path: string; statuses: Map<number, { inferrer: SchemaInferrer; empty: boolean }> }>();

  for (const file of await listJsonFiles(root)) {
    const rel = path.relative(root, file);
    const parsed = parseSampleName(rel);
    if (!parsed) {
      warnings.push(`${rel}: ignored; name it like GET.users.json or users/GET.[id].json`);
      continue;
    }

    const text = (await fs.readFile(file, 'utf8')).trim();
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (err) {
        warnings.push(`${rel}: invalid JSON, skipped (${(err as Error).message})`);
        continue;
      }
    }

    const status = parsed.status ?? (!text ? 204 : parsed.method === 'POST' ? 201 : 200);
    const key = `${parsed.method} ${parsed.path}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { method: parsed.method, path: parsed.path, statuses: new Map() }));
    let entry = group.statuses.get(status);
    if (!entry) group.statuses.set(status, (entry = { inferrer: new SchemaInferrer(), empty: true }));
    if (text) {
      entry.inferrer.add(body);
      entry.empty = false;
    }
  }

  const routes: MockRoute[] = [];
  for (const group of groups.values()) {
    const responses: MockResponse[] = [...group.statuses]
      .sort(([a], [b]) => a - b)
      .map(([status, { inferrer, empty }]) => ({
        status,
        hasExample: false,
        ...(empty ? {} : { schema: inferrer.schema(), contentType: 'application/json' }),
      }));
    routes.push({ method: group.method, path: group.path, ...compilePath(group.path), responses });
  }

  if (!routes.length) warnings.push(`${root}: no sample files found`);
  return { title: path.basename(root), version: '', basePath: '', routes: sortRoutes(routes), warnings, sources: [root] };
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
    .map((e) => path.join(e.parentPath, e.name))
    .filter((f) => !f.split(path.sep).some((seg) => seg === 'node_modules' || seg.startsWith('.')))
    .sort();
}

/** Serialize any model as an OpenAPI 3.1 document, so sample users can graduate to a spec. */
export function toOpenApi(model: MockModel): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of [...model.routes].sort((a, b) => a.path.localeCompare(b.path))) {
    const item = (paths[route.path] ??= {});
    if (route.paramNames.length && !item.parameters) {
      item.parameters = route.paramNames.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
    }
    const responses: Record<string, unknown> = {};
    for (const res of route.responses) {
      responses[res.isDefault ? 'default' : String(res.status)] = {
        description: 'Inferred from samples',
        ...(res.schema ? { content: { [res.contentType ?? 'application/json']: { schema: res.schema } } } : {}),
      };
    }
    item[route.method.toLowerCase()] = { responses };
  }
  return {
    openapi: '3.1.0',
    info: { title: model.title, version: model.version || '0.0.0' },
    paths,
  };
}

/** `toOpenApi` rendered as YAML or JSON, picked by the output file's extension. */
export function formatOpenApi(model: MockModel, outFile?: string): string {
  const doc = toOpenApi(model);
  return outFile?.toLowerCase().endsWith('.json') ? `${JSON.stringify(doc, null, 2)}\n` : stringify(doc, { aliasDuplicateObjects: false });
}
