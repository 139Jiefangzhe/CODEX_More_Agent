import { useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';

import { AgentStatusBadge } from '../components/AgentStatusBadge';
import { EmptyState } from '../components/EmptyState';
import { useWebSocket } from '../hooks/useWebSocket';
import { useSessionStore } from '../stores/session-store';
import { getAgentLabel, getEventTypeLabel, getStatusLabel } from '../utils/labels';
import { summarizeEventData } from '../utils/presentation';

export function OverviewPage() {
  const overview = useSessionStore((state) => state.overview);
  const fetchOverview = useSessionStore((state) => state.fetchOverview);

  useWebSocket({ channels: ['system'] });

  useEffect(
    function () {
      void fetchOverview();
      const timer = setInterval(function () {
        void fetchOverview();
      }, 15000);

      return function () {
        clearInterval(timer);
      };
    },
    [fetchOverview],
  );

  const totals = overview?.stats?.totals || {
    runs: 0,
    successRate: 0,
    avgDuration: 0,
  };

  const trend = Array.isArray(overview?.stats?.trend) ? overview.stats.trend.slice(-18) : [];
  const trendMax = trend.reduce(function (maxValue: number, item: any) {
    return Math.max(maxValue, Number(item?.runs || 0));
  }, 1);
  const completionPercent = Math.max(0, Math.min(100, Number(totals.successRate || 0)));

  const rankedAgents = useMemo(function () {
    const source = overview?.stats?.byAgent || {};

    return Object.entries(source)
      .map(function ([agentType, value]: [string, any]) {
        return {
          agentType,
          runs: Number(value?.runs || 0),
          successRate: Number(value?.successRate || 0),
          avgDuration: Number(value?.avgDuration || 0),
        };
      })
      .sort(function (left, right) {
        return right.runs - left.runs;
      })
      .slice(0, 5);
  }, [overview?.stats?.byAgent]);

  const ringStyle = {
    '--ring-progress': completionPercent + '%',
  } as CSSProperties;

  if (!overview) {
    return <div className="glass-card">总览加载中...</div>;
  }

  return (
    <div className="page-stack">
      <div className="bento-grid overview-grid">
        <motion.section
          className="glass-card glass-card--hero bento-item bento-item--span-3 hero-summary"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <div className="hero-summary__content">
            <div>
              <div className="hero-summary__eyebrow">Global Agent Pulse</div>
              <h3 className="hero-summary__title">Multi-Agent Runtime Overview</h3>
              <p className="hero-summary__description">
                当前共有 <strong>{overview.activeSessions.length}</strong> 个活跃会话，整体执行成功率 <strong>{totals.successRate}%</strong>。
              </p>
            </div>
            <div className="hero-summary__kpis">
              <div className="kpi-tile">
                <span className="kpi-tile__label">总运行</span>
                <span className="kpi-tile__value">{totals.runs}</span>
              </div>
              <div className="kpi-tile">
                <span className="kpi-tile__label">平均耗时</span>
                <span className="kpi-tile__value">{totals.avgDuration}s</span>
              </div>
              <div className="kpi-tile">
                <span className="kpi-tile__label">活跃会话</span>
                <span className="kpi-tile__value">{overview.activeSessions.length}</span>
              </div>
            </div>
          </div>
          <div className="progress-ring" style={ringStyle}>
            <div className="progress-ring__inner">
              <strong>{completionPercent.toFixed(1)}%</strong>
              <span>成功率</span>
            </div>
          </div>
        </motion.section>

        <motion.section
          className="glass-card bento-item"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.05 }}
        >
          <h3 className="section-title">活跃会话</h3>
          {overview.activeSessions.length === 0 ? (
            <EmptyState title="当前没有运行任务" description="可以从项目页发起一个新的工作会话。" />
          ) : null}
          <div className="list compact-list">
            {overview.activeSessions.map(function (session: any) {
              return (
                <Link key={session.id} to={'/sessions/' + session.id} className="list-row list-row--interactive">
                  <div className="list-row__meta">
                    <strong>{session.goal}</strong>
                    <span className="muted mono">{session.project_path}</span>
                    <span className="muted">阶段：{getStatusLabel(session.phase)}</span>
                  </div>
                  <div className="list-row__actions">
                    <AgentStatusBadge status={session.status} />
                  </div>
                </Link>
              );
            })}
          </div>
        </motion.section>

        <motion.section
          className="glass-card bento-item bento-item--span-2"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
        >
          <h3 className="section-title">执行趋势（最近 {trend.length} 个采样）</h3>
          <div className="sparkline-strip" role="img" aria-label="最近运行趋势">
            {trend.map(function (item: any) {
              const height = Math.max(8, Math.round((Number(item?.runs || 0) / trendMax) * 100));

              return (
                <div key={item.date} className="sparkline-bar-wrap" title={item.date + ' · ' + item.runs + ' runs'}>
                  <div className="sparkline-bar" style={{ height: height + '%' }} />
                  <span className="sparkline-label mono">{String(item.date).slice(5)}</span>
                </div>
              );
            })}
          </div>
        </motion.section>

        <motion.section
          className="glass-card bento-item bento-item--row-2"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.15 }}
        >
          <h3 className="section-title">近期事件流</h3>
          <div className="list compact-list event-feed">
            {overview.recentEvents.map(function (event: any) {
              return (
                <div key={event.id} className="list-row">
                  <div className="list-row__meta">
                    <strong>{getEventTypeLabel(event.event_type)}</strong>
                    <span className="muted mono">{event.timestamp}</span>
                    <span className="muted mono">{event.agent_run_id}</span>
                  </div>
                  <div className="list-row__actions mono event-feed__content">
                    {summarizeEventData(event.event_type, event.event_data) || JSON.stringify(event.event_data).slice(0, 160)}
                  </div>
                </div>
              );
            })}
          </div>
        </motion.section>

        <motion.section
          className="glass-card bento-item"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.2 }}
        >
          <h3 className="section-title">Agent 性能排行</h3>
          <div className="list compact-list">
            {rankedAgents.map(function (row: any) {
              return (
                <div key={row.agentType} className="list-row">
                  <div className="list-row__meta">
                    <strong>{getAgentLabel(row.agentType)}</strong>
                    <span className="muted">运行次数：{row.runs}</span>
                    <span className="muted">平均耗时：{row.avgDuration}s</span>
                  </div>
                  <div className="list-row__actions">
                    <span className="metric-badge">{row.successRate}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </motion.section>
      </div>
    </div>
  );
}
