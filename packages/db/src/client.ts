import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * Bootstrap DDL (idempotent). Hand-maintained alongside schema.ts for now — a single-user
 * local file; drizzle-kit migrations take over if/when this grows a server deployment.
 */
const BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  viewport_w INTEGER NOT NULL DEFAULT 1280,
  viewport_h INTEGER NOT NULL DEFAULT 800,
  steps_json TEXT NOT NULL DEFAULT '[]',
  meta_json TEXT NOT NULL DEFAULT '{}',
  recording_json TEXT NOT NULL DEFAULT '{}',
  hide_text_json TEXT NOT NULL DEFAULT '[]',
  active_take_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS takes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  duration_ms INTEGER,
  plan_snapshot_json TEXT NOT NULL,
  clips_override_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  project_id TEXT NOT NULL,
  take_id TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  progress REAL NOT NULL DEFAULT 0,
  message TEXT,
  pid INTEGER,
  log_path TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS renders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  take_id TEXT NOT NULL,
  job_id TEXT,
  mode TEXT NOT NULL,
  quality TEXT NOT NULL,
  output_path TEXT NOT NULL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_takes_project ON takes(project_id, created_at);
`;

function open(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(path.join(dataDir, 'studio.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(BOOTSTRAP);
  return drizzle(sqlite, { schema });
}

/** Default data dir: <cwd>/data, overridable for tests/workers. */
export function resolveDataDir(): string {
  return process.env.WDV_DATA_DIR || path.join(process.cwd(), 'data');
}

const globalForDb = globalThis as unknown as { __wdvDb?: { db: Db; dataDir: string } };

/** Singleton — mandatory under next dev HMR, which re-evaluates modules. */
export function getDb(dataDir = resolveDataDir()): Db {
  if (!globalForDb.__wdvDb || globalForDb.__wdvDb.dataDir !== dataDir) {
    globalForDb.__wdvDb = { db: open(dataDir), dataDir };
  }
  return globalForDb.__wdvDb.db;
}

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
