/**
 * `better-sqlite3` replacement backed by Node's built-in `node:sqlite`
 * (available on Node 22+/Android builds). The app only uses the small
 * synchronous subset below, so a thin adapter is enough — no native addon
 * build (which is not possible on Android without an NDK toolchain).
 */
import { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

class Statement {
  private stmt;

  constructor(stmt: unknown) {
    this.stmt = stmt as {
      run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
      get: (...params: unknown[]) => unknown;
      all: (...params: unknown[]) => unknown[];
    };
  }

  run(...params: unknown[]): RunResult {
    const result = this.stmt.run(...this.normalize(params));
    return {
      changes: Number(result?.changes ?? 0),
      lastInsertRowid: Number(result?.lastInsertRowid ?? 0),
    };
  }

  get(...params: unknown[]): Row | undefined {
    const row = this.stmt.get(...this.normalize(params));
    return row ? toPlain(row as Record<string, unknown>) : undefined;
  }

  all(...params: unknown[]): Row[] {
    return (this.stmt.all(...this.normalize(params)) as Record<string, unknown>[]).map(toPlain);
  }

  private normalize(params: unknown[]): unknown[] {
    // node:sqlite binds undefined as NULL only for explicit null; better-sqlite3
    // rejects undefined. Coerce booleans the way better-sqlite3 does (0/1).
    return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
  }
}

function toPlain(row: Record<string, unknown>): Row {
  return { ...row };
}

class Database {
  readonly path: string;
  private db: DatabaseSync;

  constructor(filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }) {
    this.path = filename;
    this.db = new DatabaseSync(filename, {
      readOnly: options?.readonly ?? false,
    });
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql));
  }

  exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  /**
   * better-sqlite3's `pragma()` returns rows for read pragmas and executes the
   * rest. Route through prepare().all() when the pragma produces rows.
   */
  pragma(statement: string): Row[] {
    const trimmed = statement.trim();
    if (/^table_info\s*\(/i.test(trimmed)) {
      return this.prepare(`PRAGMA ${trimmed}`).all();
    }
    try {
      const rows = this.prepare(`PRAGMA ${trimmed}`).all();
      if (rows.length > 0) return rows;
    } catch {
      // Statement pragmas (journal_mode = WAL, etc.) are exec-only.
    }
    this.db.exec(`PRAGMA ${trimmed}`);
    return [];
  }

  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
    return (...args: Args): R => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch { /* transaction may already be rolled back */ }
        throw err;
      }
    };
  }

  close(): void {
    this.db.close();
  }

  get open(): boolean {
    return true;
  }
}

export default Database;
export { Database };
export type { Statement };
