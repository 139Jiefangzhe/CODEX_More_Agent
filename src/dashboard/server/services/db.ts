import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

export function createDatabase(databasePath: string): Database.Database {
  const resolvedPath = path.resolve(databasePath);
  const directory = path.dirname(resolvedPath);

  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  const db = new Database(resolvedPath, { timeout: 5000 });
  const schemaPath = resolveSchemaPath();
  const schema = readFileSync(schemaPath, 'utf8');

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  return db;
}

function resolveSchemaPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, '../db/schema.sql'),
    path.resolve(process.cwd(), 'server/db/schema.sql'),
    path.resolve(process.cwd(), 'src/dashboard/server/db/schema.sql'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Cannot locate schema.sql. Checked: ' + candidates.join(', '));
}
