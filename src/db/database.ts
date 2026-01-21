import sqlite3 from 'sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../gotyolo.db');

class Database {
  private db: sqlite3.Database;

  private constructor(db: sqlite3.Database) {
    this.db = db;
  }

  static async initialize(): Promise<Database> {
    return new Promise((resolve, reject) => {
      const rawDb = new sqlite3.Database(DB_PATH, async (err) => {
        if (err) return reject(err);
        try {
          await Database.execRaw(rawDb, 'PRAGMA foreign_keys = ON');
          await Database.execRaw(rawDb, 'PRAGMA journal_mode = WAL');
          await Database.runMigrations(rawDb);
          resolve(new Database(rawDb));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  private static execRaw(db: sqlite3.Database, sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      db.run(sql, [], (err) => (err ? reject(err) : resolve()));
    });
  }

  private static async runMigrations(db: sqlite3.Database): Promise<void> {
    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) return;

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      await Database.execRaw(db, sql);
    }
  }

  run(sql: string, params: unknown[] = []): Promise<sqlite3.RunResult> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve(this);
      });
    });
  }

  get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row as T);
      });
    });
  }

  all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve((rows || []) as T[]);
      });
    });
  }

  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    await this.run('BEGIN IMMEDIATE');
    try {
      const result = await fn(this);
      await this.run('COMMIT');
      return result;
    } catch (err) {
      await this.run('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

let dbInstance: Database | null = null;

async function initializeDb(): Promise<void> {
  if (dbInstance) {
    return;
  }
  dbInstance = await Database.initialize();
}

const db: Database = new Proxy({} as Database, {
  get(_target, prop) {
    if (!dbInstance) {
      throw new Error('Database not initialized. Call initializeDb() first.');
    }
    const value = dbInstance[prop as keyof Database];
    if (typeof value === 'function') {
      return value.bind(dbInstance);
    }
    return value;
  },
});

export { db, Database, DB_PATH, initializeDb };
