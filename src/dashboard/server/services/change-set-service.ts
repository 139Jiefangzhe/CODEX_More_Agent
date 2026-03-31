import { v4 as uuidv4 } from 'uuid';

import { nowIso, parseJson, toJson } from './helpers.js';

export class ChangeSetService {
  db: any;
  eventBus: any;

  constructor(db, eventBus) {
    this.db = db;
    this.eventBus = eventBus;
  }

  createChangeSet(sessionId, summary, reviewNotes, files, diffText, testCommandSnapshot, status = 'awaiting_approval') {
    const id = uuidv4();
    const now = nowIso();
    const sql = 'INSERT INTO change_sets (id, session_id, status, summary, review_notes, files_json, diff_text, test_command_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

    this.db.prepare(sql).run(id, sessionId, status, summary, reviewNotes, toJson(files), diffText, testCommandSnapshot, now, now);
    const changeSet = this.getBySession(sessionId);

    if (!changeSet) {
      throw new Error('Failed to create change set for session ' + sessionId);
    }

    this.publish(sessionId, changeSet.id, changeSet.status);
    return changeSet;
  }

  getBySession(sessionId) {
    const row = this.db.prepare('SELECT * FROM change_sets WHERE session_id = ?').get(sessionId);
    return row ? normalizeChangeSet(row) : null;
  }

  updateStatus(sessionId, status) {
    const current = this.getBySession(sessionId);

    if (!current) {
      throw new Error('Change set not found for session ' + sessionId);
    }

    this.db.prepare('UPDATE change_sets SET status = ?, updated_at = ? WHERE session_id = ?').run(status, nowIso(), sessionId);
    const next = this.getBySession(sessionId);
    this.publish(sessionId, next.id, next.status);
    return next;
  }

  publish(sessionId, changeSetId, status) {
    const timestamp = nowIso();
    const payload = {
      type: 'changeset:update',
      timestamp,
      data: {
        sessionId,
        changeSetId,
        status,
        timestamp,
      },
    };

    this.eventBus.publish('session:' + sessionId, payload);
    this.eventBus.publish('system', payload);
  }
}

function normalizeChangeSet(row) {
  return {
    id: row.id,
    session_id: row.session_id,
    status: row.status,
    summary: row.summary,
    review_notes: row.review_notes,
    files: parseJson(row.files_json, []),
    diff_text: row.diff_text,
    test_command_snapshot: row.test_command_snapshot,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
