import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { GanttTimeline } from '../components/GanttTimeline';
import { EmptyState } from '../components/EmptyState';
import { api } from '../api/client';
import { getAgentLabel, getStatusLabel } from '../utils/labels';
import { getStatusTone } from '../utils/status-tone';

type HistoryTab = 'history' | 'timeline' | 'audit' | 'stats';

const EMPTY_HISTORY_FILTERS = {
  agent_type: '',
  status: '',
  trigger: '',
};

const EMPTY_AUDIT_FILTERS = {
  actor: '',
  action: '',
  target_type: '',
};

const CHART_TOOLTIP_STYLE = {
  borderRadius: 12,
  border: '1px solid var(--line)',
  background: 'var(--surface-strong)',
  color: 'var(--text)',
} as const;

export function HistoryPage() {
  const [tab, setTab] = useState<HistoryTab>('history');
  const [historyFilters, setHistoryFilters] = useState<any>(EMPTY_HISTORY_FILTERS);
  const [auditFilters, setAuditFilters] = useState<any>(EMPTY_AUDIT_FILTERS);
  const [historyPage, setHistoryPage] = useState<any>({ data: [], total: 0, page: 1, limit: 20 });
  const [auditPage, setAuditPage] = useState<any>({ data: [], total: 0, page: 1, limit: 50 });
  const [sessions, setSessions] = useState<any[]>([]);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [selectedTimelineSessionId, setSelectedTimelineSessionId] = useState('');
  const [stats, setStats] = useState<any>({ totals: { runs: 0, successRate: 0, avgDuration: 0 }, byAgent: {}, trend: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(function () {
    void loadInitial();
  }, []);

  useEffect(
    function () {
      if (!selectedTimelineSessionId) {
        setTimeline([]);
        return;
      }

      void loadTimeline(selectedTimelineSessionId);
    },
    [selectedTimelineSessionId],
  );

  async function loadInitial() {
    setLoading(true);
    setError('');

    try {
      const [historyResult, auditResult, sessionsResult, statsResult] = await Promise.all([
        api.history.list({ page: 1, limit: 20 }),
        api.history.auditLog({ page: 1, limit: 50 }),
        api.sessions.list({ page: 1, limit: 100 }),
        api.system.stats(),
      ]);

      setHistoryPage(historyResult);
      setAuditPage(auditResult);
      setSessions(sessionsResult.data || []);
      setStats(statsResult || {});

      const firstSessionId = sessionsResult.data?.[0]?.id;

      if (firstSessionId) {
        setSelectedTimelineSessionId(firstSessionId);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function loadHistory() {
    try {
      const result = await api.history.list({ ...historyFilters, page: 1, limit: 20 });
      setHistoryPage(result);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }

  async function loadAudit() {
    try {
      const result = await api.history.auditLog({ ...auditFilters, page: 1, limit: 50 });
      setAuditPage(result);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }

  async function loadTimeline(sessionId: string) {
    try {
      const result = await api.history.timeline(sessionId);
      setTimeline(result.timeline || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }

  const historyRows = historyPage?.data || [];
  const auditRows = auditPage?.data || [];
  const totals = stats?.totals || { runs: 0, successRate: 0, avgDuration: 0 };

  const completionPercent = Math.max(0, Math.min(100, Number(totals.successRate || 0)));
  const ringStyle = {
    '--ring-progress': completionPercent + '%',
  } as CSSProperties;

  const byAgentChartData = useMemo(function () {
    return Object.keys(stats.byAgent || {}).map(function (agentType) {
      const value = stats.byAgent[agentType];

      return {
        agent: getAgentLabel(agentType),
        runs: value.runs,
        successRate: value.successRate,
        avgDuration: value.avgDuration,
      };
    });
  }, [stats.byAgent]);

  const topAgent = byAgentChartData.slice().sort((left, right) => right.runs - left.runs)[0];

  return (
    <div className="page-stack">
      <motion.section
        className="glass-card glass-card--hero hero-summary"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="hero-summary__content">
          <div>
            <div className="hero-summary__eyebrow">History & Audit Matrix</div>
            <h3 className="hero-summary__title">历史与审计中心</h3>
            <p className="hero-summary__description">统一追踪执行历史、时间线、审计日志与统计趋势，便于复盘和定位异常。</p>
          </div>
          <div className="hero-summary__kpis">
            <div className="kpi-tile">
              <span className="kpi-tile__label">总运行次数</span>
              <span className="kpi-tile__value">{totals.runs || 0}</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">成功率</span>
              <span className="kpi-tile__value">{totals.successRate || 0}%</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">平均耗时</span>
              <span className="kpi-tile__value">{totals.avgDuration || 0}s</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">当前结果集</span>
              <span className="kpi-tile__value">{tab === 'audit' ? auditRows.length : historyRows.length}</span>
            </div>
          </div>
        </div>
        <div className="progress-ring" style={ringStyle}>
          <div className="progress-ring__inner">
            <strong>{completionPercent.toFixed(1)}%</strong>
            <span>总成功率</span>
          </div>
        </div>
      </motion.section>

      <div className="tab-row" role="tablist" aria-label="历史与审计视图切换">
        <button
          className={'tab-button' + (tab === 'history' ? ' active' : '')}
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          onClick={() => setTab('history')}
        >
          执行历史
        </button>
        <button
          className={'tab-button' + (tab === 'timeline' ? ' active' : '')}
          type="button"
          role="tab"
          aria-selected={tab === 'timeline'}
          onClick={() => setTab('timeline')}
        >
          时间线
        </button>
        <button
          className={'tab-button' + (tab === 'audit' ? ' active' : '')}
          type="button"
          role="tab"
          aria-selected={tab === 'audit'}
          onClick={() => setTab('audit')}
        >
          审计日志
        </button>
        <button
          className={'tab-button' + (tab === 'stats' ? ' active' : '')}
          type="button"
          role="tab"
          aria-selected={tab === 'stats'}
          onClick={() => setTab('stats')}
        >
          统计报表
        </button>
        <button className="button button--ghost" type="button" onClick={() => void loadInitial()}>
          刷新数据
        </button>
      </div>

      {loading ? <div className="glass-card">正在加载历史数据...</div> : null}
      {error ? (
        <div className="notice notice--error" role="alert">
          {error}
        </div>
      ) : null}

      {tab === 'history' ? (
        <div className="bento-grid history-grid">
          <section className="glass-card bento-item bento-item--span-2">
            <h3 className="section-title">筛选条件</h3>
            <form
              className="page-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void loadHistory();
              }}
            >
              <div className="form-grid">
                <label className="field">
                  <span>Agent 类型</span>
                  <select
                    className="select"
                    value={historyFilters.agent_type}
                    onChange={(event) => setHistoryFilters({ ...historyFilters, agent_type: event.target.value })}
                  >
                    <option value="">全部</option>
                    <option value="architect">架构师</option>
                    <option value="coder">开发者</option>
                    <option value="reviewer">评审员</option>
                    <option value="tester">测试员</option>
                    <option value="devops">运维</option>
                    <option value="security">安全</option>
                    <option value="uiux">设计</option>
                  </select>
                </label>
                <label className="field">
                  <span>状态</span>
                  <input
                    className="input"
                    value={historyFilters.status}
                    onChange={(event) => setHistoryFilters({ ...historyFilters, status: event.target.value })}
                    placeholder="completed / failed / pending"
                  />
                </label>
                <label className="field">
                  <span>触发方式</span>
                  <input
                    className="input"
                    value={historyFilters.trigger}
                    onChange={(event) => setHistoryFilters({ ...historyFilters, trigger: event.target.value })}
                    placeholder="dashboard / approval / auto"
                  />
                </label>
              </div>
              <div className="button-row">
                <button className="button button--primary" type="submit">
                  应用筛选
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => {
                    setHistoryFilters(EMPTY_HISTORY_FILTERS);
                    void api.history.list({ page: 1, limit: 20 }).then(setHistoryPage);
                  }}
                >
                  重置
                </button>
              </div>
            </form>
          </section>

          <section className="glass-card bento-item bento-item--span-3">
            <h3 className="section-title">执行历史</h3>
            <p className="card-subtitle">共 {historyPage?.total || historyRows.length} 条记录，点击可进入会话详情。</p>

            {historyRows.length === 0 ? <EmptyState title="没有匹配记录" description="调整筛选条件后重新查询。" /> : null}

            <div className="list" style={{ marginTop: 14 }}>
              {historyRows.map(function (row) {
                const tone = getStatusTone(row.status);

                return (
                  <Link key={row.agent_run_id} to={'/sessions/' + row.session_id} className="list-row list-row--interactive">
                    <div className="list-row__meta">
                      <strong>
                        {getAgentLabel(row.agent_type)} · {getStatusLabel(row.status)}
                      </strong>
                      <span className="muted mono">{row.session_id}</span>
                      <span className="muted">{row.goal}</span>
                      <span className="muted">触发：{row.trigger} · 耗时：{row.duration_seconds}s</span>
                    </div>
                    <div className="list-row__actions">
                      <span className={'status-pill status-pill--' + tone}>
                        <span className="status-pill__dot" aria-hidden="true" />
                        {getStatusLabel(row.status)}
                      </span>
                      <span className="pill">
                        {row.step_current}/{row.step_total || '-'}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}

      {tab === 'timeline' ? (
        <div className="bento-grid timeline-grid">
          <section className="glass-card bento-item">
            <h3 className="section-title">会话选择</h3>
            <label className="field">
              <span>选择会话</span>
              <select
                className="select"
                value={selectedTimelineSessionId}
                onChange={(event) => setSelectedTimelineSessionId(event.target.value)}
              >
                <option value="">请选择会话</option>
                {sessions.map(function (session) {
                  return (
                    <option key={session.id} value={session.id}>
                      {session.id.slice(0, 8)} · {session.goal.slice(0, 40)}
                    </option>
                  );
                })}
              </select>
            </label>

            {selectedTimelineSessionId ? (
              <div className="list compact-list" style={{ marginTop: 14 }}>
                <div className="list-row">
                  <div className="list-row__meta">
                    <strong>当前会话</strong>
                    <span className="muted mono">{selectedTimelineSessionId}</span>
                    <span className="muted">
                      {sessions.find((session) => session.id === selectedTimelineSessionId)?.goal || '未找到会话描述'}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState title="尚未选择会话" description="从下拉框选择会话后自动加载时间轨道。" />
            )}
          </section>

          <section className="glass-card bento-item bento-item--span-2">
            <h3 className="section-title">Multi-Agent 执行时间轴</h3>
            {!selectedTimelineSessionId ? (
              <EmptyState title="暂无时间轴" description="请先选择一个会话。" />
            ) : (
              <GanttTimeline timeline={timeline} />
            )}
          </section>
        </div>
      ) : null}

      {tab === 'audit' ? (
        <div className="bento-grid audit-grid">
          <section className="glass-card bento-item bento-item--span-2">
            <h3 className="section-title">审计筛选</h3>
            <form
              className="page-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void loadAudit();
              }}
            >
              <div className="form-grid">
                <label className="field">
                  <span>操作者</span>
                  <input
                    className="input"
                    value={auditFilters.actor}
                    onChange={(event) => setAuditFilters({ ...auditFilters, actor: event.target.value })}
                    placeholder="user / system"
                  />
                </label>
                <label className="field">
                  <span>操作</span>
                  <input
                    className="input"
                    value={auditFilters.action}
                    onChange={(event) => setAuditFilters({ ...auditFilters, action: event.target.value })}
                    placeholder="create / trigger / config_change"
                  />
                </label>
                <label className="field">
                  <span>目标类型</span>
                  <input
                    className="input"
                    value={auditFilters.target_type}
                    onChange={(event) => setAuditFilters({ ...auditFilters, target_type: event.target.value })}
                    placeholder="session / agent / command"
                  />
                </label>
              </div>
              <div className="button-row">
                <button className="button button--primary" type="submit">
                  应用筛选
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => {
                    setAuditFilters(EMPTY_AUDIT_FILTERS);
                    void api.history.auditLog({ page: 1, limit: 50 }).then(setAuditPage);
                  }}
                >
                  重置
                </button>
              </div>
            </form>
          </section>

          <section className="glass-card bento-item bento-item--span-3">
            <h3 className="section-title">审计日志</h3>
            <p className="card-subtitle">共 {auditPage?.total || auditRows.length} 条记录。</p>

            {auditRows.length === 0 ? <EmptyState title="没有匹配审计记录" description="调整筛选条件后重试。" /> : null}

            <div className="list" style={{ marginTop: 14 }}>
              {auditRows.map(function (row) {
                return (
                  <div key={row.id} className="list-row">
                    <div className="list-row__meta">
                      <strong>{row.action}</strong>
                      <span className="muted mono">{row.timestamp}</span>
                      <span className="muted">
                        {row.actor} · {row.target_type} · {row.target_id}
                      </span>
                      <pre className="json-snippet mono">{JSON.stringify(row.details, null, 2)}</pre>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}

      {tab === 'stats' ? (
        <div className="bento-grid stats-grid">
          <section className="glass-card bento-item">
            <h3 className="section-title">总运行</h3>
            <div className="kpi">
              <span className="kpi__label">总次数</span>
              <span className="kpi__value">{totals.runs || 0}</span>
            </div>
          </section>

          <section className="glass-card bento-item">
            <h3 className="section-title">成功率</h3>
            <div className="kpi">
              <span className="kpi__label">全局成功率</span>
              <span className="kpi__value">{totals.successRate || 0}%</span>
            </div>
          </section>

          <section className="glass-card bento-item">
            <h3 className="section-title">平均耗时</h3>
            <div className="kpi">
              <span className="kpi__label">平均秒数</span>
              <span className="kpi__value">{totals.avgDuration || 0}s</span>
            </div>
          </section>

          <section className="glass-card bento-item bento-item--span-2">
            <h3 className="section-title">按 Agent 统计</h3>
            <div className="chart">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={byAgentChartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="4 4" stroke="var(--line)" />
                  <XAxis dataKey="agent" stroke="var(--muted)" tickLine={false} axisLine={false} />
                  <YAxis stroke="var(--muted)" tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: 'rgba(15, 118, 110, 0.12)' }} />
                  <Bar dataKey="runs" fill="var(--accent)" radius={[10, 10, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="glass-card bento-item bento-item--span-2">
            <h3 className="section-title">30 天趋势</h3>
            <div className="chart">
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={stats.trend || []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="4 4" stroke="var(--line)" />
                  <XAxis dataKey="date" stroke="var(--muted)" tickLine={false} axisLine={false} />
                  <YAxis stroke="var(--muted)" tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                  <Line type="monotone" dataKey="runs" stroke="var(--accent)" strokeWidth={2.4} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="glass-card bento-item">
            <h3 className="section-title">热点 Agent</h3>
            {topAgent ? (
              <div className="list compact-list">
                <div className="list-row">
                  <div className="list-row__meta">
                    <strong>{topAgent.agent}</strong>
                    <span className="muted">运行次数：{topAgent.runs}</span>
                    <span className="muted">成功率：{topAgent.successRate}%</span>
                    <span className="muted">平均耗时：{topAgent.avgDuration}s</span>
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState title="暂无统计样本" description="执行任务后会自动生成热点 Agent 结果。" />
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
