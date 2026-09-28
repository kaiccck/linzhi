import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { AnalysisResult, LngLat } from '@zoudedao/core';
import type { FastifyBaseLogger } from 'fastify';

const gzipAsync = promisify(gzip);

/** One entry of GET /api/samples. */
export interface SampleSummary {
  id: string;
  name: string;
  center_bd09: LngLat;
  center_label?: string;
}

export interface SampleFile {
  summary: SampleSummary;
  /** Raw JSON bytes as stored on disk. */
  body: Buffer;
  etag: string;
  gzipped(): Promise<Buffer>;
}

interface Entry extends SampleFile {
  mtimeMs: number;
  size: number;
}

/** Ids are file names, so they are safe to show and to look up, and only ever matched, never joined. */
const SAMPLE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function readSummary(id: string, body: Buffer): SampleSummary {
  const { meta } = JSON.parse(body.toString('utf8')) as { meta?: Partial<AnalysisResult['meta']> };
  const center = meta?.center_bd09;
  if (
    typeof meta?.name !== 'string' ||
    !Array.isArray(center) ||
    center.length !== 2 ||
    !center.every(Number.isFinite)
  ) {
    throw new Error('meta.name 或 meta.center_bd09 缺失');
  }
  const summary: SampleSummary = { id, name: meta.name, center_bd09: [center[0], center[1]] };
  if (typeof meta.center_label === 'string') summary.center_label = meta.center_label;
  return summary;
}

/**
 * Catalogue of data/samples/*.json. Each call re-lists the directory (cheap) but re-reads a file only
 * when its size or mtime changed, so samples can be added without a restart.
 */
export class SampleStore {
  readonly dir: string;
  readonly #log: Pick<FastifyBaseLogger, 'warn'> | undefined;
  #entries = new Map<string, Entry>();
  readonly #rejected = new Map<string, string>(); // file -> "size:mtime" already warned about

  constructor(dir: string, log?: Pick<FastifyBaseLogger, 'warn'>) {
    this.dir = dir;
    this.#log = log;
  }

  async list(): Promise<SampleSummary[]> {
    const entries = await this.#scan();
    return [...entries.values()].map((entry) => entry.summary);
  }

  /** Looks the id up in the catalogue; anything that is not a listed sample is simply absent. */
  async get(id: string): Promise<SampleFile | undefined> {
    return (await this.#scan()).get(id);
  }

  /** A fresh parse per call, so callers may mutate the result. */
  async readResult(id: string): Promise<AnalysisResult> {
    const sample = await this.get(id);
    if (!sample) throw new Error(`样例 ${id} 不存在于 ${this.dir}`);
    return JSON.parse(sample.body.toString('utf8')) as AnalysisResult;
  }

  async #scan(): Promise<Map<string, Entry>> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((name) => name.endsWith('.json')).sort();
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return (this.#entries = new Map());
      throw err;
    }
    const next = new Map<string, Entry>();
    for (const name of names) {
      const id = name.slice(0, -'.json'.length);
      if (!SAMPLE_ID.test(id)) continue;
      const file = join(this.dir, name);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) continue;
      const cached = this.#entries.get(id);
      if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
        next.set(id, cached);
        continue;
      }
      const version = `${info.size}:${info.mtimeMs}`;
      try {
        const body = await readFile(file);
        let zipped: Promise<Buffer> | undefined;
        next.set(id, {
          summary: readSummary(id, body),
          body,
          etag: `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`,
          gzipped: () => (zipped ??= gzipAsync(body)),
          mtimeMs: info.mtimeMs,
          size: info.size,
        });
      } catch (err) {
        if (this.#rejected.get(file) !== version) {
          this.#rejected.set(file, version);
          this.#log?.warn({ file, reason: (err as Error).message }, '跳过无法读取的样例文件');
        }
      }
    }
    this.#entries = next;
    return next;
  }
}
