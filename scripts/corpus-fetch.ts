// Download the corpus specs listed in corpus/specs.json into corpus/.cache/.
// URLs are pinned to commits, so a cached file never goes stale.
import fs from 'node:fs/promises';
import path from 'node:path';

export const CACHE_DIR = path.join(import.meta.dirname, '..', 'corpus', '.cache');

export interface CorpusSpec {
  name: string;
  url: string;
}

export async function readManifest(): Promise<CorpusSpec[]> {
  const file = path.join(import.meta.dirname, '..', 'corpus', 'specs.json');
  return JSON.parse(await fs.readFile(file, 'utf8')).specs;
}

export function cachePath(spec: CorpusSpec): string {
  return path.join(CACHE_DIR, `${spec.name}${path.extname(new URL(spec.url).pathname) || '.yaml'}`);
}

async function fetchOne(spec: CorpusSpec): Promise<'cached' | 'fetched'> {
  const file = cachePath(spec);
  if (await fs.stat(file).catch(() => undefined)) return 'cached';
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(spec.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      return 'fetched';
    } catch (err) {
      if (attempt >= 3) throw new Error(`${spec.name}: ${(err as Error).message} (${spec.url})`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const specs = await readManifest();
  let fetched = 0;
  const failures: string[] = [];
  // A few at a time: polite to GitHub, still quick.
  for (let i = 0; i < specs.length; i += 6) {
    const results = await Promise.allSettled(specs.slice(i, i + 6).map(fetchOne));
    for (const r of results) {
      if (r.status === 'rejected') failures.push(String((r.reason as Error).message));
      else if (r.value === 'fetched') fetched++;
    }
  }
  console.log(`corpus: ${specs.length - failures.length}/${specs.length} specs ready (${fetched} downloaded)`);
  if (failures.length) {
    for (const f of failures) console.error(`  ✖ ${f}`);
    process.exit(1);
  }
}
