import sqlite3 from 'sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../gotyolo.db');

let dbInstance: sqlite3.Database | null = null;

export function getDb(): sqlite3.Database {
  if (dbInstance) return dbInstance;

  dbInstance = new sqlite3.Database(DB_PATH);
  dbInstance.run('PRAGMA foreign_keys = ON');
  dbInstance.run('PRAGMA journal_mode = WAL');

  runMigrations(dbInstance);
  return dbInstance;
}

function runMigrations(db: sqlite3.Database): void {
  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  migrationFiles.forEach((file) => {
    const migrationPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    db.exec(sql);
  });
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export { DB_PATH };
