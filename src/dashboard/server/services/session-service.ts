import { v4 as uuidv4 } from 'uuid';

import { nowIso, parseJson, toJson } from './helpers.js';

export class SessionService {
  db: any;
  eventBus: any;

  constructor(db, eventBus) {
    this.db = db;
    this.eventBus = eventBus;
  }

  createSession(project, goal, triggerSource = 'dashboard') {
    const id = uuidv4();
    const now = nowIso();
    const sql = 'INSERT INTO sessions (id, project_id, project_path, goal, start_time, status, phase, trigger_source, metadata, active_change_set_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)';

    this.db.prepare(sql).run(id, project.id, project.root_path, goal.trim(), now, 'running', 'planning', triggerSource, toJson({ goal }));
    return this.getSession(id);
  }

  listSessions(filters: any = {}) {
    const page = Math.max(filters.page ?? 1, 1);
    const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);
    const conditions = [];
    const params = [];

    if (filters.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }

    if (filters.project_id) {
      conditions.push('project_id = ?');
      params.push(filters.project_id);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const totalRow = this.db.prepare('SELECT COUNT(*) as total FROM sessions ' + whereClause).get(...params);
    const rows = this.db
      .prepare('SELECT * FROM sessions ' + whereClause + ' ORDER BY start_time DESC LIMIT ? OFFSET ?')
      .all(...params, limit, (page - 1) * limit);

    return {
      data: rows.map(normalizeSession),
      total: totalRow.total,
      page,
      limit,
    };
  }

  listActiveSessions() {
    const rows = this.db.prepare("SELECT * FROM sessions WHERE status = 'running' ORDER BY start_time DESC LIMIT 20").all();
    return rows.map(normalizeSession);
  }

  getSession(id) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ? normalizeSession(row) : null;
  }

  updateSession(id, updates) {
    const current = this.getSession(id);

    if (!current) {
      throw new Error('Session not found: ' + id);
    }

    const next = {
      ...current,
      ...updates,
      metadata: updates.metadata === undefined ? current.metadata : updates.metadata,
      active_change_set_id:
        updates.active_change_set_id === undefined ? current.active_change_set_id : updates.active_change_set_id,
      end_time: updates.end_time === undefined ? current.end_time : updates.end_time,
    };

    this.db.prepare('UPDATE sessions SET status = ?, phase = ?, metadata = ?, active_change_set_id = ?, end_time = ? WHERE id = ?').run(
      next.status,
      next.phase,
      toJson(next.metadata),
      next.active_change_set_id,
      next.end_time,
      id,
    );

    const timestamp = nowIso();
    const payload = {
      type: 'session:update',
      timestamp,
      data: {
        sessionId: id,
        phase: next.phase,
        status: next.status,
        timestamp,
      },
    };

    this.eventBus.publish('session:' + id, payload);
    this.eventBus.publish('system', payload);
    return next;
  }

  markFailed(id, errorMessage) {
    const session = this.updateSession(id, {
      status: 'failed',
      phase: 'failed',
      end_time: nowIso(),
    });

    this.appendAudit('system', 'update', 'session', id, { error: errorMessage, status: 'failed' });
    return session;
  }

  markCompleted(id) {
    return this.updateSession(id, {
      status: 'completed',
      phase: 'completed',
      end_time: nowIso(),
    });
  }

  markAborted(id, reason) {
    const session = this.updateSession(id, {
      status: 'aborted',
      phase: 'aborted',
      end_time: nowIso(),
    });

    this.appendAudit('user', 'control', 'session', id, { reason, status: 'aborted' });
    return session;
  }

  getBlockingSessions(projectId, excludeSessionId) {
    const params = [projectId];
    let sql = "SELECT * FROM sessions WHERE project_id = ? AND status = 'running' AND phase IN ('awaiting_approval', 'applying', 'testing')";

    if (excludeSessionId) {
      sql += ' AND id != ?';
      params.push(excludeSessionId);
    }

    return this.db.prepare(sql).all(...params).map(normalizeSession);
  }

  appendAudit(actor, action, targetType, targetId, details) {
    this.db.prepare('INSERT INTO audit_log (timestamp, actor, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)').run(
      nowIso(),
      actor,
      action,
      targetType,
      targetId,
      toJson(details),
    );
  }
}

function normalizeSession(row) {
  return {
    ...row,
    metadata: parseJson(row.metadata, null),
  };
}
