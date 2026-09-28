/**
 * Tiny key–value store shared by the response cache and the quota ledger. Uses the built-in
 * `node:sqlite` when the runtime has it (Node ≥ 22.13 unflagged) and falls back to a Map otherwise.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

export interface KvEntry {
  value: string;
  /** Unix ms; null = never expires. */
  expiresAt: number | null;
}

export interface KvStore {
  readonly kind: 'sqlite' | 'memory';
  /** Database file, or null for the in-memory store. */
  readonly path: string | null;
  get(ns: string, key: string): KvEntry | undefined;
  set(ns: string, key: string, value: string, expiresAt: number | null): void;
  delete(ns: string, key: string): void;
  /** Deletes expired entries; returns how many. */
  purgeExpired(now: number): number;
  count(ns?: string): number;
  close(): void;
}

export class MemoryStore implements KvStore {
  readonly kind = 'memory' as const;
  readonly path = null;
  private readonly data = new Map<string, KvEntry & { ns: string }>();

  get(ns: string, key: string): KvEntry | undefined {
    const e = this.data.get(`${ns}\u0000${key}`);
    return e && { value: e.value, expiresAt: e.expiresAt };
  }

  set(ns: string, key: string, value: string, expiresAt: number | null): void {
    this.data.set(`${ns}\u0000${key}`, { ns, value, expiresAt });
  }

  delete(ns: string, key: string): void {
    this.data.delete(`${ns}\u0000${key}`);
  }

  purgeExpired(now: number): number {
    let n = 0;
    for (const [k, e] of this.data) {
      if (e.expiresAt !== null && e.expiresAt <= now) {
        this.data.delete(k);
        n++;
      }
    }
    return n;
  }

  count(ns?: string): number {
    if (ns === undefined) return this.data.size;
    let n = 0;
    for (const e of this.data.values()) if (e.ns === ns) n++;
    return n;
  }

  close(): void {
    this.data.clear();
  }
}

export class SqliteStore implements KvStore {
  readonly kind = 'sqlite' as const;
  private readonly getStmt: StatementSync;
  private readonly setStmt: StatementSync;
  private readonly delStmt: StatementSync;
  private readonly purgeStmt: StatementSync;
  private readonly countAll: StatementSync;
  private readonly countNs: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    readonly path: string,
  ) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS kv (
        ns TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (ns, key)
      ) WITHOUT ROWID;
    `);
    this.getStmt = db.prepare('SELECT value, expires_at FROM kv WHERE ns = ? AND key = ?');
    this.setStmt = db.prepare(
      `INSERT INTO kv (ns, key, value, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
    );
    this.delStmt = db.prepare('DELETE FROM kv WHERE ns = ? AND key = ?');
    this.purgeStmt = db.prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?');
    this.countAll = db.prepare('SELECT COUNT(*) AS n FROM kv');
    this.countNs = db.prepare('SELECT COUNT(*) AS n FROM kv WHERE ns = ?');
  }

  get(ns: string, key: string): KvEntry | undefined {
    const row = this.getStmt.get(ns, key);
    if (!row || typeof row.value !== 'string') return undefined;
    const exp = row.expires_at;
    return { value: row.value, expiresAt: exp === null || exp === undefined ? null : Number(exp) };
  }

  set(ns: string, key: string, value: string, expiresAt: number | null): void {
    this.setStmt.run(ns, key, value, expiresAt, Date.now());
  }

  delete(ns: string, key: string): void {
    this.delStmt.run(ns, key);
  }

  purgeExpired(now: number): number {
    return Number(this.purgeStmt.run(now).changes);
  }

  count(ns?: string): number {
    const row = ns === undefined ? this.countAll.get() : this.countNs.get(ns);
    return Number(row?.n ?? 0);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

type SqliteModule = typeof import('node:sqlite');

function loadSqlite(): SqliteModule | undefined {
  try {
    return process.getBuiltinModule('node:sqlite');
  } catch {
    return undefined;
  }
}

export interface OpenStoreOptions {
  /** Called when the store falls back to memory (no node:sqlite, unwritable path …). */
  onWarning?: (message: string) => void;
}

/**
 * Opens the shared store. `path` null → memory; ':memory:' → in-memory SQLite; otherwise a file whose
 * parent directories are created on demand.
 */
export function openStore(path: string | null, opts: OpenStoreOptions = {}): KvStore {
  if (path === null) return new MemoryStore();
  const sqlite = loadSqlite();
  if (!sqlite) {
    opts.onWarning?.('当前 Node 不支持 node:sqlite（需要 ≥ 22.13），缓存与配额账本只保存在内存中');
    return new MemoryStore();
  }
  try {
    const file = path === ':memory:' ? path : resolve(path);
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    return new SqliteStore(new sqlite.DatabaseSync(file), file);
  } catch (err) {
    opts.onWarning?.(
      `无法打开缓存数据库 ${path}（${err instanceof Error ? err.message : String(err)}），改为内存缓存`,
    );
    return new MemoryStore();
  }
}
