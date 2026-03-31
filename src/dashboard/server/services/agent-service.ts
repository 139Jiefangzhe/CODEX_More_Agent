import { v4 as uuidv4 } from 'uuid';

import { nowIso, parseJson, toJson, truncate } from './helpers.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'aborted', 'skipped']);

export class AgentService {
  db: any;
  eventBus: any;

  constructor(db, eventBus) {
    this.db = db;
    this.eventBus = eventBus;
  }

  createAgentRun(sessionId, agentType, trigger, inputSummary, stepTotal) {
    const id = uuidv4();
    const now = nowIso();
    const sql = 'INSERT INTO agent_runs (id, session_id, agent_type, started_at, status, trigger, input_summary, output_summary, step_current, step_total) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)';

    this.db.prepare(sql).run(id, sessionId, agentType, now, 'pending', trigger, truncate(inputSummary, 500), stepTotal ?? null);
    return this.getRun(id);
  }

  getRun(id) {
    return this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) ?? null;
  }

  listSessionRuns(sessionId) {
    return this.db.prepare('SELECT * FROM agent_runs WHERE session_id = ? ORDER BY started_at ASC').all(sessionId);
  }

  updateRunStatus(runId, sessionId, agentType, status, outputSummary) {
    const current = this.getRun(runId);

    if (!current) {
      throw new Error('Agent run not found: ' + runId);
    }

    const finishedAt = status === 'completed' || status === 'failed' || status === 'aborted' ? nowIso() : null;
    const nextSummary = outputSummary ? truncate(outputSummary, 500) : current.output_summary;

    this.db.prepare('UPDATE agent_runs SET status = ?, output_summary = ?, finished_at = ? WHERE id = ?').run(
      status,
      nextSummary,
      finishedAt,
      runId,
    );

    const timestamp = nowIso();
    const payload = {
      type: 'agent:status_change',
      timestamp,
      data: {
        sessionId,
        agentRunId: runId,
        agentType,
        oldStatus: current.status,
        newStatus: status,
        timestamp,
      },
    };

    this.eventBus.publish('session:' + sessionId, payload);
    this.eventBus.publish('system', payload);

    if (TERMINAL_RUN_STATUSES.has(String(status))) {
      this.consumePendingControlSignals(runId, sessionId, nowIso());
    }

    return this.getRun(runId);
  }

  updateRunProgress(runId, stepCurrent, stepTotal) {
    this.db.prepare('UPDATE agent_runs SET step_current = ?, step_total = COALESCE(?, step_total) WHERE id = ?').run(
      stepCurrent,
      stepTotal ?? null,
      runId,
    );
  }

  appendEvent(input) {
    const timestamp = nowIso();
    const result = this.db.prepare('INSERT INTO agent_events (agent_run_id, session_id, timestamp, event_type, event_data) VALUES (?, ?, ?, ?, ?)').run(
      input.runId,
      input.sessionId,
      timestamp,
      input.eventType,
      toJson(input.eventData),
    );

    const event = {
      id: Number(result.lastInsertRowid),
      agent_run_id: input.runId,
      session_id: input.sessionId,
      timestamp,
      event_type: input.eventType,
      event_data: input.eventData,
    };
    const payload = {
      type: 'agent:event',
      timestamp,
      data: {
        sessionId: input.sessionId,
        agentRunId: input.runId,
        agentType: input.agentType,
        eventType: input.eventType,
        payload: input.eventData,
        timestamp,
        eventId: Number(result.lastInsertRowid),
      },
    };

    this.eventBus.publish('session:' + input.sessionId, payload);
    this.eventBus.publish('system', payload);
    return event;
  }

  listEvents(runId, filters: any = {}) {
    const page = Math.max(filters.page ?? 1, 1);
    const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
    const conditions = ['agent_run_id = ?'];
    const params = [runId];

    if (filters.event_type) {
      conditions.push('event_type = ?');
      params.push(filters.event_type);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');
    const totalRow = this.db.prepare('SELECT COUNT(*) as total FROM agent_events ' + whereClause).get(...params);
    const rows = this.db.prepare('SELECT * FROM agent_events ' + whereClause + ' ORDER BY id ASC LIMIT ? OFFSET ?').all(
      ...params,
      limit,
      (page - 1) * limit,
    );

    return {
      data: rows.map(normalizeEvent),
      total: totalRow.total,
      page,
      limit,
    };
  }

  getRecentEvents(limit = 20) {
    const rows = this.db.prepare('SELECT * FROM agent_events ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(normalizeEvent).reverse();
  }

  getStats() {
    const rows = this.db.prepare("SELECT agent_type, COUNT(*) as runs, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_runs, AVG((julianday(COALESCE(finished_at, started_at)) - julianday(started_at)) * 86400.0) as avg_duration FROM agent_runs GROUP BY agent_type").all();
    const totalsRow = this.db.prepare("SELECT COUNT(*) as runs, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_runs, AVG((julianday(COALESCE(finished_at, started_at)) - julianday(started_at)) * 86400.0) as avg_duration FROM agent_runs").get();
    const trendRows = this.db
      .prepare(
        "SELECT substr(started_at, 1, 10) as day, COUNT(*) as runs, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_runs FROM agent_runs WHERE started_at >= ? GROUP BY day ORDER BY day ASC",
      )
      .all(startOfDayIso(29));
    const byAgent: Record<string, any> = {};
    const trendMap = new Map();

    for (const row of rows) {
      byAgent[row.agent_type] = {
        runs: row.runs,
        successRate: row.runs > 0 ? Number((((row.completed_runs ?? 0) / row.runs) * 100).toFixed(1)) : 0,
        avgDuration: Number((row.avg_duration ?? 0).toFixed(2)),
      };
    }

    for (const row of trendRows) {
      trendMap.set(row.day, {
        runs: row.runs,
        successRate: row.runs > 0 ? Number((((row.completed_runs ?? 0) / row.runs) * 100).toFixed(1)) : 0,
      });
    }

    const trend = [];

    for (let offset = 29; offset >= 0; offset -= 1) {
      const day = startOfDayIso(offset);
      const value = trendMap.get(day) ?? { runs: 0, successRate: 0 };
      trend.push({
        date: day,
        runs: value.runs,
        successRate: value.successRate,
      });
    }

    return {
      totals: {
        runs: totalsRow.runs,
        successRate: totalsRow.runs > 0 ? Number((((totalsRow.completed_runs ?? 0) / totalsRow.runs) * 100).toFixed(1)) : 0,
        avgDuration: Number((totalsRow.avg_duration ?? 0).toFixed(2)),
      },
      byAgent,
      trend,
    };
  }

  consumePendingControlSignals(runId, sessionId, timestamp) {
    const signals = this.db
      .prepare('SELECT id, action FROM control_signals WHERE agent_run_id = ? AND consumed_at IS NULL ORDER BY id ASC')
      .all(runId);

    if (!signals.length) {
      return;
    }

    this.db.prepare('UPDATE control_signals SET consumed_at = ? WHERE agent_run_id = ? AND consumed_at IS NULL').run(timestamp, runId);

    for (const signal of signals) {
      const payload = {
        type: 'agent:control_applied',
        timestamp,
        data: {
          sessionId,
          agentRunId: runId,
          action: signal.action,
          signalId: signal.id,
          mode: 'checkpoint',
          result: 'ignored_terminal',
          timestamp,
        },
      };

      this.eventBus.publish('session:' + sessionId, payload);
      this.eventBus.publish('system', payload);
    }
  }
}

function normalizeEvent(row) {
  return {
    ...row,
    event_data: parseJson(row.event_data, {}),
  };
}

function startOfDayIso(daysAgo: number) {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}
