import path from 'node:path';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import type { MockModel, MockParameter, MockRequestBody, MockResponse, MockRoute, Schema } from './model.js';
import { DISCRIMINATOR, type Discriminator, fits, mergeAllOf } from './schema.js';

export const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

export class SpecLoadError extends Error {
  constructor(
    message: string,
    /** Absolute path of the spec; the message shows paths relative to the working directory. */
    readonly file: string,
  ) {
    super(relativePaths(`${file}: ${message.replace(/, open '[^']*'$/, '')}`));
    this.name = 'SpecLoadError';
  }
}

/**
 * Shorten absolute paths under the working directory, in any spelling the ref parser
 * uses: `C:\a\b`, `c:/a/b` (Windows) or `/a/b`. Paths elsewhere are left as they are.
 */
function relativePaths(text: string, cwd = process.cwd()): string {
  const segments = cwd.split(/[\\/]/).filter(Boolean).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const prefix = (cwd.startsWith('/') ? '[\\\\/]' : '') + segments.join('[\\\\/]') + '[\\\\/]';
  return text.replace(new RegExp(prefix, process.platform === 'win32' ? 'gi' : 'g'), '');
}

/** Load an OpenAPI 3.0/3.1 file (YAML or JSON, multi-file `$ref`s allowed) into the normalized model. */
export async function loadOpenApi(file: string): Promise<MockModel> {
  const abs = path.resolve(file);
  const parser = new $RefParser();
  let doc: any;
  try {
    // Circular refs are kept as object cycles; the generator caps recursion depth.
    doc = await parser.dereference(abs, { dereference: { circular: true } });
  } catch (err) {
    throw new SpecLoadError((err as Error).message, abs);
  }

  if (doc?.swagger) {
    throw new SpecLoadError(
      `Swagger ${doc.swagger} is not supported; convert it to OpenAPI 3 first (e.g. with swagger2openapi).`,
      abs,
    );
  }
  if (typeof doc?.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    throw new SpecLoadError('not an OpenAPI 3.x document (missing or unsupported `openapi` field).', abs);
  }

  const warnings: string[] = [];
  const routes: MockRoute[] = [];
  resolveDiscriminators(doc, (ref) => {
    try {
      return parser.$refs.get(ref) as Schema;
    } catch {
      return undefined;
    }
  });

  for (const [routePath, pathItem] of Object.entries<any>(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const responses = collectResponses(op.responses ?? {}, `${method.toUpperCase()} ${routePath}`, warnings);
      routes.push({
        method: method.toUpperCase(),
        path: routePath,
        ...compilePath(routePath),
        operationId: op.operationId,
        responses,
        parameters: collectParameters(pathItem.parameters, op.parameters),
        requestBody: collectRequestBody(op.requestBody),
      });
    }
  }

  sortRoutes(routes);

  return {
    openapi: doc.openapi,
    title: doc.info?.title ?? path.basename(abs),
    version: doc.info?.version ?? '',
    basePath: basePathOf(doc.servers?.[0]?.url),
    routes,
    warnings,
    sources: parser.$refs.paths().filter((p) => !/^https?:/.test(p)),
  };
}

/**
 * Attach each `discriminator`'s value → branch mapping to its schema. Dereferencing
 * turned the mapping's `$ref` strings into nothing we can follow, so they're resolved
 * here, by identity. Branches without an explicit mapping use their component name,
 * as the spec says. Only discriminators that cover every branch are attached.
 */
function resolveDiscriminators(doc: any, resolve: (ref: string) => Schema | undefined) {
  const names = new Map<object, string>();
  for (const [name, s] of Object.entries<Schema>(doc.components?.schemas ?? {})) if (s && typeof s === 'object') names.set(s, name);
  const lookup = (ref: string) => (/[#/]/.test(ref) ? resolve(ref) : doc.components?.schemas?.[ref]);

  const seen = new Set<object>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach(visit);
    const s = node as Schema;
    const branches: Schema[] | undefined = s.oneOf ?? s.anyOf;
    const property = s.discriminator?.propertyName;
    if (typeof property === 'string' && Array.isArray(branches)) {
      const mapping: Discriminator['mapping'] = [];
      for (const [value, ref] of Object.entries<string>(s.discriminator.mapping ?? {})) {
        const target = lookup(ref);
        if (target && branches.includes(target)) mapping.push({ value, schema: target });
      }
      for (const b of branches) {
        if (mapping.some((m) => m.schema === b)) continue;
        // Implicit mapping is the component name, but most specs instead pin the
        // property to one value (`type: {enum: [track]}`); prefer whichever fits.
        const prop = (b.allOf ? mergeAllOf(b) : b).properties?.[property];
        const pinned = prop && ('const' in prop ? [prop.const] : Array.isArray(prop.enum) && prop.enum.length === 1 ? prop.enum : undefined);
        const name = names.get(b);
        const value = pinned?.[0] ?? (name && (!prop || fits(name, prop)) ? name : undefined);
        if (typeof value === 'string') mapping.push({ value, schema: b });
      }
      if (branches.every((b) => mapping.some((m) => m.schema === b))) (s as any)[DISCRIMINATOR] = { property, mapping } satisfies Discriminator;
    }
    for (const v of Object.values(s)) visit(v);
  };
  visit(doc);
}

/** Path-level parameters apply to every operation; an operation's own parameter with the same name and location replaces one. */
function collectParameters(pathLevel: unknown, opLevel: unknown): MockParameter[] {
  const byKey = new Map<string, MockParameter>();
  for (const list of [pathLevel, opLevel]) {
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (!p || typeof p.name !== 'string' || !['path', 'query', 'header', 'cookie'].includes(p.in)) continue;
      // A parameter's schema is usually under `schema`, rarely under `content`.
      const schema = p.schema ?? (Object.values<any>(p.content ?? {})[0]?.schema as Schema | undefined);
      byKey.set(`${p.in}:${p.name}`, { name: p.name, in: p.in, required: p.in === 'path' || !!p.required, schema });
    }
  }
  return [...byKey.values()];
}

function collectRequestBody(body: any): MockRequestBody | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const contentTypes = Object.keys(body.content ?? {});
  const json = contentTypes.find((t) => /^application\/(.+\+)?json/i.test(t));
  return { required: !!body.required, schema: json ? body.content[json]?.schema : undefined, contentTypes };
}

function collectResponses(responses: Record<string, any>, label: string, warnings: string[]): MockResponse[] {
  const out: MockResponse[] = [];
  for (const [code, res] of Object.entries(responses)) {
    let status: number;
    let isDefault = false;
    if (code === 'default') {
      status = 200;
      isDefault = true;
    } else if (/^[1-5]XX$/i.test(code)) {
      status = Number(code[0]) * 100;
    } else if (/^\d{3}$/.test(code)) {
      status = Number(code);
    } else {
      warnings.push(`${label}: ignoring unknown response code "${code}"`);
      continue;
    }

    const [contentType, media] = pickMedia(res?.content);
    const example = media ? firstExample(media) : undefined;
    out.push({
      status,
      isDefault,
      contentType,
      schema: media?.schema as Schema | undefined,
      example: example?.value,
      hasExample: example !== undefined,
    });
  }
  return out;
}

function pickMedia(content: Record<string, any> | undefined): [string | undefined, any] {
  if (!content) return [undefined, undefined];
  const types = Object.keys(content);
  const json =
    types.find((t) => t === 'application/json') ??
    types.find((t) => /[/+]json\b/.test(t)) ??
    types.find((t) => t === '*/*') ??
    types[0];
  return json ? [json, content[json]] : [undefined, undefined];
}

function firstExample(media: any): { value: unknown } | undefined {
  if (media.example !== undefined) return { value: media.example };
  const first = media.examples && Object.values<any>(media.examples)[0];
  if (first && 'value' in first) return { value: first.value };
  return undefined;
}

/** Literal segments win over params: `/users/me` must match before `/users/{id}`. */
export function sortRoutes(routes: MockRoute[]): MockRoute[] {
  return routes.sort((a, b) => a.paramNames.length - b.paramNames.length);
}

export function compilePath(template: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const source = template
    .split('/')
    .map((seg) =>
      seg.replace(/\{([^}]+)\}|[^{]+/g, (m, name?: string) => {
        if (name) {
          paramNames.push(name);
          return '([^/]+)';
        }
        return m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }),
    )
    .join('/');
  return { pattern: new RegExp(`^${source}/?$`), paramNames };
}

function basePathOf(url: unknown): string {
  if (typeof url !== 'string') return '';
  try {
    const p = new URL(url, 'http://localhost').pathname.replace(/\/+$/, '');
    // Server variables like `/{version}` can't be matched literally; ignore them.
    return p.includes('{') ? '' : p;
  } catch {
    return '';
  }
}
