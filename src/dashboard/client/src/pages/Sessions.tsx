import { useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';

import { AgentStatusBadge } from '../components/AgentStatusBadge';
import { EmptyState } from '../components/EmptyState';
import { useSessionStore } from '../stores/session-store';
import { getStatusLabel } from '../utils/labels';
import { getStatusTone } from '../utils/status-tone';

export function SessionsPage() {
  const sessionsPage = useSessionStore((state) => state.sessionsPage);
  const fetchSessions = useSessionStore((state) => state.fetchSessions);

  const sessions = sessionsPage?.data || [];

  useEffect(
    function () {
      void fetchSessions();
      const timer = setInterval(function () {
        void fetchSessions();
      }, 15000);

      return function () {
        clearInterval(timer);
      };
    },
    [fetchSessions],
  );

  const summary = useMemo(function () {
    return sessions.reduce(
      function (acc, session) {
        acc.total += 1;

        if (session.status === 'running' || session.status === 'pending') {
          acc.running += 1;
        }

        if (session.phase === 'awaiting_approval') {
          acc.awaitingApproval += 1;
        }

        if (session.status === 'failed' || session.status === 'aborted') {
          acc.failed += 1;
        }

        return acc;
      },
      { total: 0, running: 0, awaitingApproval: 0, failed: 0 },
    );
  }, [sessions]);

  const phaseDistribution = useMemo(function () {
    const map = new Map<string, number>();

    sessions.forEach(function (session) {
      const key = String(session.phase || 'unknown');
      map.set(key, (map.get(key) || 0) + 1);
    });

    return Array.from(map.entries())
      .map(function ([phase, count]) {
        return {
          phase,
          count,
        };
      })
      .sort(function (left, right) {
        return right.count - left.count;
      });
  }, [sessions]);

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
            <div className="hero-summary__eyebrow">Session Control Center</div>
            <h3 className="hero-summary__title">会话中心</h3>
            <p className="hero-summary__description">实时扫描正在运行、待审批与历史会话，快速进入任一执行链路。</p>
          </div>
          <div className="hero-summary__kpis">
            <div className="kpi-tile">
              <span className="kpi-tile__label">会话总数</span>
              <span className="kpi-tile__value">{summary.total}</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">运行中</span>
              <span className="kpi-tile__value">{summary.running}</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">待审批</span>
              <span className="kpi-tile__value">{summary.awaitingApproval}</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">失败/中止</span>
              <span className="kpi-tile__value">{summary.failed}</span>
            </div>
          </div>
        </div>
        <div className="button-row">
          <button className="button button--ghost" type="button" onClick={() => void fetchSessions()}>
            立即刷新
          </button>
          <Link className="button button--primary" to="/">
            新建会话
          </Link>
        </div>
      </motion.section>

      <div className="bento-grid sessions-grid">
        <motion.section
          className="glass-card bento-item bento-item--span-2"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.05 }}
        >
          <h3 className="section-title">全部会话</h3>
          <p className="card-subtitle">点击任意会话可查看执行节点、实时日志和审批变更。</p>

          {sessions.length === 0 ? <EmptyState title="暂无会话" description="从项目页发起第一条任务后，这里会自动出现。" /> : null}

          <div className="list" style={{ marginTop: 14 }}>
            {sessions.map(function (session) {
              const phaseTone = getStatusTone(session.phase);

              return (
                <Link key={session.id} to={'/sessions/' + session.id} className="list-row list-row--interactive">
                  <div className="list-row__meta">
                    <strong>{session.goal}</strong>
                    <span className="muted mono">{session.project_path}</span>
                    <span className="muted">阶段：{getStatusLabel(session.phase)}</span>
                  </div>
                  <div className="list-row__actions">
                    <span className={'status-pill status-pill--' + phaseTone}>
                      <span className="status-pill__dot" aria-hidden="true" />
                      {getStatusLabel(session.phase)}
                    </span>
                    <AgentStatusBadge status={session.status} />
                  </div>
                </Link>
              );
            })}
          </div>
        </motion.section>

        <motion.section
          className="glass-card bento-item"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
        >
          <h3 className="section-title">阶段分布</h3>
          <p className="card-subtitle">通过阶段聚合快速发现阻塞点与审批堆积。</p>

          <div className="list compact-list" style={{ marginTop: 14 }}>
            {phaseDistribution.length === 0 ? (
              <EmptyState title="暂无数据" description="会话运行后自动生成阶段分布。" />
            ) : (
              phaseDistribution.map(function (item) {
                const tone = getStatusTone(item.phase);

                return (
                  <div key={item.phase} className="list-row">
                    <div className="list-row__meta">
                      <strong>{getStatusLabel(item.phase)}</strong>
                      <span className="muted mono">phase: {item.phase}</span>
                    </div>
                    <div className="list-row__actions">
                      <span className={'status-pill status-pill--' + tone}>
                        <span className="status-pill__dot" aria-hidden="true" />
                        {item.count}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </motion.section>
      </div>
    </div>
  );
}
