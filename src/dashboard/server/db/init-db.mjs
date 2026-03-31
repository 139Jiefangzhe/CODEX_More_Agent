import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const dashboardRoot = path.resolve(currentDir, '..', '..');
const schemaPath = path.resolve(currentDir, 'schema.sql');
const databasePath = path.resolve(dashboardRoot, process.env.DATABASE_URL || process.env.DASHBOARD_DB || './data/dashboard.db');

if (!fs.existsSync(schemaPath)) {
  console.error('Schema not found:', schemaPath);
  process.exit(1);
}

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const schemaSql = fs.readFileSync(schemaPath, 'utf8');
const db = new Database(databasePath);

try {
  db.exec(schemaSql);
  console.log('Database initialized:', databasePath);
} finally {
  db.close();
}
