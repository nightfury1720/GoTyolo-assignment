import { Pool, PoolClient, QueryResult } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

export const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://gotyolo:gotyolo123@postgres:5432/gotyolo';

// Convert SQLite-style ? placeholders to PostgreSQL $1, $2, $3... format
function convertPlaceholders(sql: string): string {
    let paramIndex = 1;
    return sql.replace(/\?/g, () => `$${paramIndex++}`);
}

export class Database {
    private pool: Pool;

    private constructor(pool: Pool) {
        this.pool = pool;
    }

    static async initialize(): Promise<Database> {
        const pool = new Pool({
            connectionString: DATABASE_URL,
            max: 20, // Maximum number of clients in the pool
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });

        // Test the connection
        const client = await pool.connect();
        try {
            await client.query('SELECT 1');
            await Database.runMigrations(client);
        } finally {
            client.release();
        }

        return new Database(pool);
    }

    private static async runMigrations(client: PoolClient): Promise<void> {
        const migrationsDir = path.join(__dirname, 'migrations');
        if (!fs.existsSync(migrationsDir)) return;

        const migrationFiles = fs
            .readdirSync(migrationsDir)
            .filter((f) => f.endsWith('.sql'))
            .sort();

        for (const file of migrationFiles) {
            const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
            await client.query(sql);
        }
    }

    run(sql: string, params: unknown[] = []): Promise<QueryResult> {
        return this.pool.query(convertPlaceholders(sql), params);
    }

    get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
        return this.pool.query(convertPlaceholders(sql), params).then(result => result.rows[0] || undefined);
    }

    all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        return this.pool.query(convertPlaceholders(sql), params).then(result => result.rows);
    }

    async transaction<T>(fn: (db: TransactionDatabase) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await fn(new TransactionDatabase(client));
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    close(): void {
        this.pool.end();
    }
}

// Wrapper for transaction client
export class TransactionDatabase {
    private client: PoolClient;

    constructor(client: PoolClient) {
        this.client = client;
    }

    run(sql: string, params: unknown[] = []): Promise<QueryResult> {
        return this.client.query(convertPlaceholders(sql), params);
    }

    get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
        return this.client.query(convertPlaceholders(sql), params).then(result => result.rows[0] || undefined);
    }

    all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        return this.client.query(convertPlaceholders(sql), params).then(result => result.rows);
    }

    // Override transaction to prevent nested transactions
    async transaction<T>(fn: (db: TransactionDatabase) => Promise<T>): Promise<T> {
        return fn(this);
    }

    close(): void {
        // Don't close the client in transactions
    }
}

let dbInstance: Database | null = null;

export async function initializeDb(): Promise<void> {
    if (dbInstance) {
        return;
    }
    dbInstance = await Database.initialize();
}

export const db: Database = new Proxy({} as Database, {
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