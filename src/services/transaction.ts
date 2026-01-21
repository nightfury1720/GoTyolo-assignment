import sqlite3 from 'sqlite3';
import { getDb } from '../db/database';

export function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<sqlite3.RunResult> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (this: sqlite3.RunResult, err: Error | null) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

export function get<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err: Error | null, row: T) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

export function all<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err: Error | null, rows: T[]) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

export async function withTransaction<T>(fn: (db: sqlite3.Database) => Promise<T>): Promise<T> {
  const db = getDb();

  await run(db, 'BEGIN IMMEDIATE');

  try {
    const result = await fn(db);
    await run(db, 'COMMIT');
    return result;
  } catch (err) {
    await run(db, 'ROLLBACK');
    throw err;
  }
}
