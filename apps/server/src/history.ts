/**
 * Persistent history (SQLite via node:sqlite, WAL): every completed live analysis for 30 days, the
 * what-if measurements made on an analysis (its branches, same retention), and walking routes by OD
 * pair (kept forever: a walk between two points does not change with the day). The file is
 * data/cache/analyses.sqlite by default (ZDD_HISTORY_PATH); without node:sqlite, with an unwritable
 * path, or with ZDD_HISTORY_PATH=off the same store lives in memory and ends with the process.
 *
 * Results are stored gzipped (a live result is 250–450 KB of JSON, about a quarter of that gzipped)
 * together with the columns the history list needs: centre, label, profile, rules, name, headline.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { HARD_CATEGORIES, type AnalysisResult, type HardCategory, type LngLat } from '@zoudedao/core';
import type { WhatIfResult } from './whatif.js';

export const HISTORY_TTL_DAYS = 30;
/** Live analyses GET /api/history lists (newest first). */
export const HISTORY_RECENT = 20;
/** Branches GET /api/analysis/:id/branches lists (newest first). */
export const BRANCHES_MAX = 50;
const DAY_MS = 86_400_000;

/** The numbers the area dropdown shows: size, the circle's overstatement, gaps under the task rule. */
export interface HistoryHeadline {
  communities: number;
  area_iso15_km2: number | null;
  area_circle15_km2: number | null;
  overstate_x: number | null;
  /** Verified checks not walkable within the rule: 伪覆盖 + 盲区. */
  walking_gaps: number;
  pseudo: number;
  blind: number;
  /** Checks not verified yet (待核实), never counted as gaps. */
  pending: number;
}

/** One entry of GET /api/history. */
export interface HistoryItem {
  id: string;
  /** A bundled sample (data/samples) rather than a stored live analysis. */
  sample: boolean;
  /** When the live analysis was stored; for samples meta.generated. ISO 8601. */
  created_at: string;
  center_bd09: LngLat;
  label: string | null;
  profile: 'adult' | 'elder';
  /** Always the task rule (1 km); kept for older clients. */
  rules: 'task';
  name: string;
  headline: HistoryHeadline;
}

/** A what-if measurement saved on its analysis: POST /api/whatif's answer plus an id and a time. */
export type WhatIfBranch = WhatIfResult & { id: string; created_at: string };

/** A walking route kept by OD pair (GET /api/route). */
export interface StoredRoute {
  from_bd09: LngLat;
  to_bd09: LngLat;
  distance_m: number;
  duration_s: number;
  path_bd09: LngLat[];
  /** When Baidu answered it, ISO 8601. */
  fetched_at: string;
}

type Profile = HistoryItem['profile'];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function gapCounts(r: AnalysisResult) {
  let pseudo = 0;
  let blind = 0;
  let pending = 0;
  for (const c of r.communities ?? []) {
    for (const cat of HARD_CATEGORIES) {
      const k = c.checks?.[cat as HardCategory];
      if (!k) continue;
      if (k.verified === false) {
        pending++;
        continue;
      }
      if (k.status_main === '伪覆盖') pseudo++;
      else if (k.status_main === '盲区') blind++;
    }
  }
  return { walking_gaps: pseudo + blind, pseudo, blind, pending };
}

/** Headline numbers of a result, the same counting as the advisor's headline() (待核实 never a gap). */
export function historyHeadline(r: AnalysisResult): HistoryHeadline {
  const s = (r.stats ?? {}) as Record<string, unknown>;
  return {
    communities: r.communities?.length ?? 0,
    area_iso15_km2: num(s.area_iso15_km2),
    area_circle15_km2: num(s.area_circle15_km2),
    overstate_x: num(s.overstate_x),
    ...gapCounts(r),
  };
}

/** A stored headline without the fields older versions kept (the GB 50180 counts *_gb). */
function storedHeadline(json: string): HistoryHeadline {
  const h = JSON.parse(json) as HistoryHeadline;
  return {
    communities: h.communities,
    area_iso15_km2: h.area_iso15_km2,
    area_circle15_km2: h.area_circle15_km2,
    overstate_x: h.overstate_x,
    walking_gaps: h.walking_gaps,
    pseudo: h.pseudo,
    blind: h.blind,
    pending: h.pending,
  };
}

const metaOf = (r: AnalysisResult) =>
  r.meta as AnalysisResult['meta'] & { profile?: string; analysis_id?: string };

/** The history entry of a result (live results: pass the POST /api/analyze input for label and profile). */
export function historyItem(
  id: string,
  r: AnalysisResult,
  opts: { sample: boolean; created_at: string; label?: string | null; profile?: string | null },
): HistoryItem {
  const m = metaOf(r);
  const profile = (opts.profile ?? m.profile) === 'elder' ? 'elder' : 'adult';
  return {
    id,
    sample: opts.sample,
    created_at: opts.created_at,
    center_bd09: [m.center_bd09[0], m.center_bd09[1]],
    label: opts.label ?? m.center_label ?? null,
    profile,
    rules: 'task',
    name: m.name,
    headline: historyHeadline(r),
  };
}

/** FNV-1a 32-bit, as the agent's AnalysisStore.liveId: short stable ids without node:crypto. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The same what-if again (analysis, category, rules, site to 1e-6°) replaces its branch. */
export function branchId(w: Pick<WhatIfResult, 'analysis_id' | 'category' | 'rules' | 'site_bd09'>): string {
  const site = w.site_bd09.map((v) => v.toFixed(6)).join(',');
  return `wi-${fnv1a(`${w.analysis_id}|${w.category}|${w.rules}|${site}`)}`;
}

// ------------------------------------------------------------------------------ tables

interface AnalysisRow {
  id: string;
  created_at: number;
  expires_at: number;
  center_lng: number;
  center_lat: number;
  label: string | null;
  profile: string;
  rules: string;
  name: string;
  headline: string;
  result: Uint8Array;
}

type AnalysisMetaRow = Omit<AnalysisRow, 'result'>;

interface BranchRow {
  id: string;
  analysis_id: string;
  created_at: number;
  expires_at: number;
  category: string;
  rules: string;
  site_lng: number;
  site_lat: number;
  result: string;
}

/** The few operations the store needs, over SQLite or plain maps. */
interface Tables {
  readonly kind: 'sqlite' | 'memory';
  putAnalysis(row: AnalysisRow): void;
  getAnalysis(id: string, now: number): AnalysisRow | undefined;
  hasAnalysis(id: string, now: number): boolean;
  recent(limit: number, now: number): AnalysisMetaRow[];
  putBranch(row: BranchRow): void;
  branches(analysisId: string, limit: number, now: number): BranchRow[];
  getRoute(key: string): string | undefined;
  putRoute(key: string, value: string, now: number): void;
  purge(now: number): number;
  close(): void;
}

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 2000;
  CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    center_lng REAL NOT NULL,
    center_lat REAL NOT NULL,
    label TEXT,
    profile TEXT NOT NULL,
    rules TEXT NOT NULL,
    name TEXT NOT NULL,
    headline TEXT NOT NULL,
    result BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS analyses_created ON analyses (created_at);
  CREATE TABLE IF NOT EXISTS branches (
    id TEXT PRIMARY KEY,
    analysis_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    category TEXT NOT NULL,
    rules TEXT NOT NULL,
    site_lng REAL NOT NULL,
    site_lat REAL NOT NULL,
    result TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS branches_analysis ON branches (analysis_id, created_at);
  CREATE TABLE IF NOT EXISTS routes (
    key TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    value TEXT NOT NULL
  );
`;

type Statement =
  | 'putAnalysis'
  | 'getAnalysis'
  | 'hasAnalysis'
  | 'recent'
  | 'putBranch'
  | 'branches'
  | 'getRoute'
  | 'putRoute'
  | 'purgeAnalyses'
  | 'purgeBranches';

class SqliteTables implements Tables {
  readonly kind = 'sqlite' as const;
  readonly #db: DatabaseSync;
  readonly #s: Readonly<Record<Statement, StatementSync>>;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(SCHEMA);
    const meta = 'id, created_at, expires_at, center_lng, center_lat, label, profile, rules, name, headline';
    this.#s = {
      putAnalysis: db.prepare(
        `INSERT INTO analyses (${meta}, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at, center_lng = excluded.center_lng,
         center_lat = excluded.center_lat, label = excluded.label, profile = excluded.profile,
         rules = excluded.rules, name = excluded.name, headline = excluded.headline, result = excluded.result`,
      ),
      getAnalysis: db.prepare(`SELECT ${meta}, result FROM analyses WHERE id = ? AND expires_at > ?`),
      hasAnalysis: db.prepare('SELECT 1 AS hit FROM analyses WHERE id = ? AND expires_at > ?'),
      recent: db.prepare(
        `SELECT ${meta} FROM analyses WHERE expires_at > ? ORDER BY created_at DESC, id LIMIT ?`,
      ),
      putBranch: db.prepare(
        `INSERT INTO branches (id, analysis_id, created_at, expires_at, category, rules, site_lng, site_lat, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET created_at = excluded.created_at, expires_at = excluded.expires_at,
         result = excluded.result`,
      ),
      branches: db.prepare(
        `SELECT id, analysis_id, created_at, expires_at, category, rules, site_lng, site_lat, result
         FROM branches WHERE analysis_id = ? AND expires_at > ? AND rules = 'task'
         ORDER BY created_at DESC, id LIMIT ?`,
      ),
      getRoute: db.prepare('SELECT value FROM routes WHERE key = ?'),
      putRoute: db.prepare(
        `INSERT INTO routes (key, created_at, value) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ),
      purgeAnalyses: db.prepare('DELETE FROM analyses WHERE expires_at <= ?'),
      purgeBranches: db.prepare('DELETE FROM branches WHERE expires_at <= ?'),
    };
  }

  putAnalysis(r: AnalysisRow): void {
    this.#s.putAnalysis.run(
      r.id,
      r.created_at,
      r.expires_at,
      r.center_lng,
      r.center_lat,
      r.label,
      r.profile,
      r.rules,
      r.name,
      r.headline,
      r.result,
    );
  }

  getAnalysis(id: string, now: number): AnalysisRow | undefined {
    return this.#s.getAnalysis.get(id, now) as AnalysisRow | undefined;
  }

  hasAnalysis(id: string, now: number): boolean {
    return this.#s.hasAnalysis.get(id, now) !== undefined;
  }

  recent(limit: number, now: number): AnalysisMetaRow[] {
    return this.#s.recent.all(now, limit) as unknown as AnalysisMetaRow[];
  }

  putBranch(b: BranchRow): void {
    this.#s.putBranch.run(
      b.id,
      b.analysis_id,
      b.created_at,
      b.expires_at,
      b.category,
      b.rules,
      b.site_lng,
      b.site_lat,
      b.result,
    );
  }

  branches(analysisId: string, limit: number, now: number): BranchRow[] {
    return this.#s.branches.all(analysisId, now, limit) as unknown as BranchRow[];
  }

  getRoute(key: string): string | undefined {
    const row = this.#s.getRoute.get(key) as { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? row.value : undefined;
  }

  putRoute(key: string, value: string, now: number): void {
    this.#s.putRoute.run(key, now, value);
  }

  purge(now: number): number {
    return Number(this.#s.purgeAnalyses.run(now).changes) + Number(this.#s.purgeBranches.run(now).changes);
  }

  close(): void {
    try {
      this.#db.close();
    } catch {
      // already closed
    }
  }
}

/** Without node:sqlite (or without persistence): the same tables in maps, bounded. */
class MemoryTables implements Tables {
  readonly kind = 'memory' as const;
  readonly #analyses = new Map<string, AnalysisRow>();
  readonly #branches = new Map<string, BranchRow>();
  readonly #routes = new Map<string, string>();
  /** Results held in memory at most (each about 100 KB gzipped). */
  static readonly MAX_ANALYSES = 100;
  static readonly MAX_ROUTES = 5000;

  putAnalysis(row: AnalysisRow): void {
    const prev = this.#analyses.get(row.id);
    this.#analyses.delete(row.id);
    this.#analyses.set(row.id, prev ? { ...row, created_at: prev.created_at } : row);
    for (const oldest of this.#analyses.keys()) {
      if (this.#analyses.size <= MemoryTables.MAX_ANALYSES) break;
      this.#analyses.delete(oldest);
    }
  }

  getAnalysis(id: string, now: number): AnalysisRow | undefined {
    const row = this.#analyses.get(id);
    return row && row.expires_at > now ? row : undefined;
  }

  hasAnalysis(id: string, now: number): boolean {
    return this.getAnalysis(id, now) !== undefined;
  }

  recent(limit: number, now: number): AnalysisMetaRow[] {
    return [...this.#analyses.values()]
      .filter((r) => r.expires_at > now)
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map(({ result: _result, ...meta }) => meta);
  }

  putBranch(row: BranchRow): void {
    this.#branches.set(row.id, row);
    if (this.#branches.size > MemoryTables.MAX_ANALYSES * BRANCHES_MAX) {
      const oldest = [...this.#branches.values()].sort((a, b) => a.created_at - b.created_at)[0];
      if (oldest) this.#branches.delete(oldest.id);
    }
  }

  branches(analysisId: string, limit: number, now: number): BranchRow[] {
    return [...this.#branches.values()]
      .filter((b) => b.analysis_id === analysisId && b.expires_at > now && b.rules === 'task')
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }

  getRoute(key: string): string | undefined {
    return this.#routes.get(key);
  }

  putRoute(key: string, value: string): void {
    this.#routes.set(key, value);
    for (const oldest of this.#routes.keys()) {
      if (this.#routes.size <= MemoryTables.MAX_ROUTES) break;
      this.#routes.delete(oldest);
    }
  }

  purge(now: number): number {
    let n = 0;
    for (const [id, r] of this.#analyses) if (r.expires_at <= now && this.#analyses.delete(id)) n++;
    for (const [id, b] of this.#branches) if (b.expires_at <= now && this.#branches.delete(id)) n++;
    return n;
  }

  close(): void {
    this.#analyses.clear();
    this.#branches.clear();
    this.#routes.clear();
  }
}

// ------------------------------------------------------------------------------- store

export interface HistoryStoreOptions {
  /** SQLite file; null = in memory (tests, ZDD_HISTORY_PATH=off). */
  path: string | null;
  ttlDays?: number;
  now?: () => number;
  /** Chinese warning when the file cannot be used and the store falls back to memory. */
  onWarning?: (message: string) => void;
}

type SqliteModule = typeof import('node:sqlite');

function loadSqlite(): SqliteModule | undefined {
  try {
    return process.getBuiltinModule('node:sqlite');
  } catch {
    return undefined;
  }
}

export class HistoryStore {
  /** The SQLite file actually in use; null when the store is in memory. */
  readonly path: string | null;
  readonly ttlMs: number;
  readonly #tables: Tables;
  readonly #now: () => number;

  constructor(opts: HistoryStoreOptions) {
    this.#now = opts.now ?? Date.now;
    this.ttlMs = (opts.ttlDays ?? HISTORY_TTL_DAYS) * DAY_MS;
    let tables: Tables | undefined;
    let path: string | null = null;
    if (opts.path !== null) {
      const sqlite = loadSqlite();
      if (!sqlite) {
        opts.onWarning?.('当前 Node 不支持 node:sqlite（需要 ≥ 22.13），体检历史只保存在内存中，重启后清空');
      } else {
        let db: DatabaseSync | undefined;
        try {
          const file = resolve(opts.path);
          mkdirSync(dirname(file), { recursive: true });
          db = new sqlite.DatabaseSync(file);
          tables = new SqliteTables(db);
          path = file;
        } catch (err) {
          try {
            db?.close();
          } catch {
            // not open
          }
          opts.onWarning?.(
            `无法打开体检历史数据库 ${opts.path}（${err instanceof Error ? err.message : String(err)}），改为保存在内存中`,
          );
        }
      }
    }
    this.#tables = tables ?? new MemoryTables();
    this.path = path;
    this.purge();
  }

  /** Stored in a file: ids survive a restart. */
  get persistent(): boolean {
    return this.#tables.kind === 'sqlite';
  }

  get retentionDays(): number {
    return this.ttlMs / DAY_MS;
  }

  /** Stores a live result under its meta.analysis_id (again: same id, same result; keeps created_at). */
  saveAnalysis(
    id: string,
    result: AnalysisResult,
    input: { label?: string | null; profile?: string | null } = {},
  ): HistoryItem {
    const now = this.#now();
    const item = historyItem(id, result, {
      sample: false,
      created_at: new Date(now).toISOString(),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
    });
    this.#tables.putAnalysis({
      id,
      created_at: now,
      expires_at: now + this.ttlMs,
      center_lng: item.center_bd09[0],
      center_lat: item.center_bd09[1],
      label: item.label,
      profile: item.profile,
      rules: item.rules,
      name: item.name,
      headline: JSON.stringify(item.headline),
      result: gzipSync(JSON.stringify(result)),
    });
    this.#tables.purge(now);
    return item;
  }

  /** The stored result's gzipped JSON, or undefined when unknown or expired. */
  analysisGzip(id: string): Buffer | undefined {
    const row = this.#tables.getAnalysis(id, this.#now());
    return row ? Buffer.from(row.result) : undefined;
  }

  getAnalysis(id: string): AnalysisResult | undefined {
    const gz = this.analysisGzip(id);
    return gz ? (JSON.parse(gunzipSync(gz).toString('utf8')) as AnalysisResult) : undefined;
  }

  hasAnalysis(id: string): boolean {
    return this.#tables.hasAnalysis(id, this.#now());
  }

  /** The newest stored live analyses (not expired), newest first. */
  recent(limit = HISTORY_RECENT): HistoryItem[] {
    return this.#tables.recent(limit, this.#now()).map((r) => ({
      id: r.id,
      sample: false,
      created_at: new Date(r.created_at).toISOString(),
      center_bd09: [r.center_lng, r.center_lat],
      label: r.label,
      profile: (r.profile === 'elder' ? 'elder' : 'adult') as Profile,
      rules: 'task',
      name: r.name,
      headline: storedHeadline(r.headline),
    }));
  }

  /** Saves a what-if measurement as a branch of its analysis; the same what-if replaces its branch. */
  saveBranch(w: WhatIfResult): WhatIfBranch {
    const now = this.#now();
    const branch: WhatIfBranch = { id: branchId(w), created_at: new Date(now).toISOString(), ...w };
    this.#tables.putBranch({
      id: branch.id,
      analysis_id: w.analysis_id,
      created_at: now,
      expires_at: now + this.ttlMs,
      category: w.category,
      rules: w.rules,
      site_lng: w.site_bd09[0],
      site_lat: w.site_bd09[1],
      result: JSON.stringify(branch),
    });
    return branch;
  }

  /** Branches of an analysis, newest first; what-ifs under the retired GB 50180 rule are left out. */
  branches(analysisId: string, limit = BRANCHES_MAX): WhatIfBranch[] {
    return this.#tables.branches(analysisId, limit, this.#now()).map((b) => ({
      ...(JSON.parse(b.result) as WhatIfBranch),
      created_at: new Date(b.created_at).toISOString(),
    }));
  }

  getRoute(key: string): StoredRoute | undefined {
    const value = this.#tables.getRoute(key);
    return value ? (JSON.parse(value) as StoredRoute) : undefined;
  }

  /** Walking routes never expire. */
  putRoute(key: string, route: StoredRoute): void {
    this.#tables.putRoute(key, JSON.stringify(route), this.#now());
  }

  /** Deletes expired analyses and branches; returns how many. */
  purge(): number {
    return this.#tables.purge(this.#now());
  }

  close(): void {
    this.#tables.close();
  }
}
