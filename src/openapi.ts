import path from 'node:path';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import type { MockModel, MockResponse, MockRoute, Schema } from './model.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

export class SpecLoadError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'SpecLoadError';
  }
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
      });
    }
  }

  // Literal segments win over params: `/users/me` must match before `/users/{id}`.
  routes.sort((a, b) => a.paramNames.length - b.paramNames.length);

  return {
    title: doc.info?.title ?? path.basename(abs),
    version: doc.info?.version ?? '',
    basePath: basePathOf(doc.servers?.[0]?.url),
    routes,
    warnings,
    sources: parser.$refs.paths().filter((p) => !/^https?:/.test(p)),
  };
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
