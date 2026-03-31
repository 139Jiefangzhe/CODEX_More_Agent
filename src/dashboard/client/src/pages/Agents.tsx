import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';

import { AgentStatusBadge } from '../components/AgentStatusBadge';
import { AgentTriggerForm } from '../components/AgentTriggerForm';
import { api } from '../api/client';
import { getAgentLabel, getStatusLabel } from '../utils/labels';

const AGENT_TYPES = ['architect', 'coder', 'reviewer', 'tester', 'devops', 'security', 'uiux'];
const AGENT_DESCRIPTIONS: Record<string, string> = {
  architect: '负责架构规划与方案拆解。',
  coder: '负责具体实现与代码生成。',
  reviewer: '负责变更评审与风险提示。',
  tester: '负责测试准备与验证建议。',
  devops: '负责部署与流程优化建议。',
  security: '负责安全检查与风险分析。',
  uiux: '负责界面与交互优化建议。',
};

export function AgentsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({ totals: { runs: 0, successRate: 0, avgDuration: 0 }, byAgent: {} });
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(function () {
    void loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    setError('');

    try {
      const [projectsResult, historyResult, statsResult] = await Promise.all([
        api.projects.list(),
        api.history.list({ page: 1, limit: 200 }),
        api.system.stats(),
      ]);

      setProjects(projectsResult);
      setHistory(historyResult.data || []);
      setStats(statsResult || { totals: { runs: 0 }, byAgent: {} });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  const latestByAgent = useMemo(function () {
    const map = new Map();

    for (const row of history) {
      if (!map.has(row.agent_type)) {
        map.set(row.agent_type, row);
      }
    }

    return map;
  }, [history]);

  const hotAgents = useMemo(function () {
    const byAgent = stats.byAgent || {};

    return Object.entries(byAgent)
      .map(function ([agentType, value]: [string, any]) {
        return {
          agentType,
          runs: Number(value?.runs || 0),
          successRate: Number(value?.successRate || 0),
        };
      })
      .sort(function (left, right) {
        return right.runs - left.runs;
      })
      .slice(0, 3);
  }, [stats.byAgent]);

  return (
    <div className="page-stack">
      <motion.section
        className="glass-card glass-card--hero"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="hero-summary__content">
          <div>
            <div className="hero-summary__eyebrow">Agent Runtime Matrix</div>
            <h3 className="hero-summary__title">Agent 管理与触发中心</h3>
            <p className="hero-summary__description">统一监控 7 个专业 Agent 的状态、执行质量与触发入口。</p>
          </div>
          <div className="hero-summary__kpis">
            <div className="kpi-tile">
              <span className="kpi-tile__label">总运行</span>
              <span className="kpi-tile__value">{stats.totals?.runs || 0}</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">成功率</span>
              <span className="kpi-tile__value">{stats.totals?.successRate || 0}%</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">平均耗时</span>
              <span className="kpi-tile__value">{stats.totals?.avgDuration || 0}s</span>
            </div>
          </div>
        </div>
        <div className="button-row">
          <button className="button button--ghost" onClick={() => void loadData()}>
            刷新
          </button>
        </div>
      </motion.section>

      {error ? <div className="notice notice--error">{error}</div> : null}
      {loading ? <div className="glass-card">加载中...</div> : null}

      <div className="bento-grid agents-grid">
        <motion.section
          className="glass-card bento-item"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.05 }}
        >
          <h3 className="section-title">热点 Agent</h3>
          <div className="list compact-list">
            {hotAgents.map(function (item: any) {
              return (
                <div key={item.agentType} className="list-row">
                  <div className="list-row__meta">
                    <strong>{getAgentLabel(item.agentType)}</strong>
                    <span className="muted">运行次数：{item.runs}</span>
                  </div>
                  <div className="list-row__actions">
                    <span className="metric-badge">{item.successRate}%</span>
                  </div>
                </div>
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
          <h3 className="section-title">最近运行</h3>
          <div className="list compact-list">
            {history.slice(0, 8).map(function (row) {
              return (
                <div key={row.agent_run_id} className="list-row">
                  <div className="list-row__meta">
                    <strong>{getAgentLabel(row.agent_type)} · {getStatusLabel(row.status)}</strong>
                    <span className="muted">{row.goal}</span>
                    <span className="muted mono">{row.started_at}</span>
                  </div>
                  <div className="list-row__actions">
                    <button className="button button--ghost" onClick={() => navigate('/sessions/' + row.session_id)}>
                      查看会话
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </motion.section>

        {AGENT_TYPES.map(function (agentType, index) {
          const latest = latestByAgent.get(agentType);
          const stat = stats.byAgent?.[agentType] || { runs: 0, successRate: 0, avgDuration: 0 };

          return (
            <motion.article
              key={agentType}
              className="glass-card bento-item agent-card"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: 0.12 + index * 0.02 }}
              whileHover={{ y: -6 }}
            >
              <div className="agent-card__header">
                <strong>{getAgentLabel(agentType)}</strong>
                <AgentStatusBadge status={latest?.status || 'pending'} />
              </div>
              <p className="card-subtitle">{AGENT_DESCRIPTIONS[agentType]}</p>
              <div className="list-row__meta" style={{ marginTop: 10 }}>
                <span className="muted">运行次数：{stat.runs}</span>
                <span className="muted">成功率：{stat.successRate}%</span>
                <span className="muted">平均耗时：{stat.avgDuration}s</span>
                {latest ? <span className="muted mono">最近运行：{latest.started_at}</span> : <span className="muted">最近运行：无</span>}
              </div>
              <div className="button-row" style={{ marginTop: 14 }}>
                <button className="button button--primary" onClick={() => setActiveAgent(agentType)}>
                  触发
                </button>
                {latest?.session_id ? (
                  <button className="button button--ghost" onClick={() => navigate('/sessions/' + latest.session_id)}>
                    查看会话
                  </button>
                ) : null}
              </div>
            </motion.article>
          );
        })}
      </div>

      {activeAgent ? (
        <div className="modal">
          <div className="modal__panel">
            <h3 className="section-title">触发 {getAgentLabel(activeAgent)}</h3>
            <AgentTriggerForm
              agentType={activeAgent}
              projects={projects}
              onCancel={() => setActiveAgent(null)}
              onTriggered={(result) => {
                setActiveAgent(null);
                navigate('/sessions/' + result.sessionId);
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
