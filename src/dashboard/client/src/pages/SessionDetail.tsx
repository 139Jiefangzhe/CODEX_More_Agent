import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useParams } from 'react-router-dom';

import { AgentControlPanel } from '../components/AgentControlPanel';
import { AgentLogViewer } from '../components/AgentLogViewer';
import { AgentStatusBadge } from '../components/AgentStatusBadge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { WorkflowGraph } from '../components/WorkflowGraph';
import { useWebSocket } from '../hooks/useWebSocket';
import { useSessionStore } from '../stores/session-store';
import { getAgentLabel, getStatusLabel } from '../utils/labels';
import { formatReviewNotes, translateMessage } from '../utils/presentation';
import { getStatusTone } from '../utils/status-tone';

export function SessionDetailPage() {
  const params = useParams();
  const sessionId = params.id as string;
  const detail = useSessionStore((state) => state.currentDetail);
  const events = useSessionStore((state) => state.currentEvents);
  const selectedRunId = useSessionStore((state) => state.selectedRunId);
  const fetchSessionDetail = useSessionStore((state) => state.fetchSessionDetail);
  const fetchAgentEvents = useSessionStore((state) => state.fetchAgentEvents);
  const selectRun = useSessionStore((state) => state.selectRun);
  const approveCurrent = useSessionStore((state) => state.approveCurrent);
  const rejectCurrent = useSessionStore((state) => state.rejectCurrent);
  const abortCurrent = useSessionStore((state) => state.abortCurrent);
  const [runTests, setRunTests] = useState(true);
  const [dialog, setDialog] = useState<'reject' | 'abort' | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  useWebSocket({ channels: ['session:' + sessionId] });

  useEffect(
    function () {
      void fetchSessionDetail(sessionId);
    },
    [fetchSessionDetail, sessionId],
  );

  useEffect(
    function () {
      if (detail?.changeSet?.files?.length) {
        setActiveFile(detail.changeSet.files[0].path);
      }
    },
    [detail?.changeSet],
  );

  const activeChangeFile =
    useMemo(
      () => detail?.changeSet?.files.find((file) => file.path === activeFile) || detail?.changeSet?.files?.[0] || null,
      [activeFile, detail?.changeSet],
    ) || null;
  const selectedRun = useMemo(
    () => detail?.agents.find((run) => run.id === selectedRunId) || detail?.agents.at(-1) || null,
    [detail?.agents, selectedRunId],
  );

  const runStats = useMemo(function () {
    const agents = detail?.agents || [];

    return {
      total: agents.length,
      running: agents.filter((run) => run.status === 'running' || run.status === 'pending').length,
      failed: agents.filter((run) => run.status === 'failed' || run.status === 'aborted').length,
      completed: agents.filter((run) => run.status === 'completed').length,
    };
  }, [detail?.agents]);

  if (!detail) {
    return <div className="glass-card">会话详情加载中...</div>;
  }

  return (
    <div className="page-stack">
      <motion.section
        className="glass-card glass-card--hero"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="hero-summary__content">
          <div>
            <div className="hero-summary__eyebrow">Session Runtime</div>
            <h3 className="hero-summary__title">{detail.session.goal}</h3>
            <p className="hero-summary__description mono">{detail.project.root_path}</p>
            <div className="button-row" style={{ marginTop: 12 }}>
              <span className={'status-pill status-pill--' + getStatusTone(detail.session.phase)}>
                <span className="status-pill__dot" aria-hidden="true" />
                {getStatusLabel(detail.session.phase)}
              </span>
              <AgentStatusBadge status={detail.session.status} />
            </div>
          </div>
          <div className="hero-summary__kpis">
            <div className="kpi-tile">
              <span className="kpi-tile__label">执行节点</span>
              <span className="kpi-tile__value">{runStats.total}</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">运行中</span>
              <span className="kpi-tile__value">{runStats.running}</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">失败/中止</span>
              <span className="kpi-tile__value">{runStats.failed}</span>
            </div>
            <div className="kpi-tile">
              <span className="kpi-tile__label">已完成</span>
              <span className="kpi-tile__value">{runStats.completed}</span>
            </div>
          </div>
        </div>
        <div className="button-row">
          <button className="button button--danger" onClick={() => setDialog('abort')}>
            中止会话
          </button>
        </div>
      </motion.section>

      <div className="bento-grid session-grid">
        <motion.section
          className="glass-card bento-item bento-item--span-2"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.05 }}
        >
          <h3 className="section-title">Multi-Agent 执行轨道</h3>
          <WorkflowGraph agentRuns={detail.agents} onNodeClick={selectRun} />
        </motion.section>

        <motion.section
          className="glass-card bento-item"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
        >
          <h3 className="section-title">执行节点</h3>
          <div className="list compact-list">
            {detail.agents.map(function (run) {
              const isActive = selectedRunId === run.id;

              return (
                <button
                  key={run.id}
                  className={'list-row list-row--button' + (isActive ? ' list-row--active' : '')}
                  onClick={() => selectRun(run.id)}
                >
                  <div className="list-row__meta">
                    <strong>{getAgentLabel(run.agent_type)}</strong>
                    <span className="muted mono">{run.id}</span>
                  </div>
                  <div className="list-row__actions">
                    <AgentStatusBadge status={run.status} />
                  </div>
                </button>
              );
            })}
          </div>
        </motion.section>

        <motion.section
          className="glass-card bento-item bento-item--span-2 bento-item--row-2"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.15 }}
        >
          <h3 className="section-title">变更集审阅</h3>
          {!detail.changeSet ? <EmptyState title="尚未生成变更集" description="当前总控仍在规划、实现或评审阶段。" /> : null}
          {detail.changeSet ? (
            <div className="page-stack">
              <div className="button-row">
                <span className={'status-pill status-pill--' + getStatusTone(detail.changeSet.status)}>
                  <span className="status-pill__dot" aria-hidden="true" />
                  {getStatusLabel(detail.changeSet.status)}
                </span>
                <span className="muted">{translateMessage(detail.changeSet.summary)}</span>
              </div>

              <div className="card-subtitle page-stack" style={{ whiteSpace: 'pre-wrap' }}>
                {formatReviewNotes(detail.changeSet.review_notes)}
              </div>

              <div className="file-tabs">
                {detail.changeSet.files.map(function (file) {
                  return (
                    <button
                      key={file.path}
                      className={'file-tab' + (activeChangeFile?.path === file.path ? ' active' : '')}
                      onClick={() => setActiveFile(file.path)}
                    >
                      {file.path}
                    </button>
                  );
                })}
              </div>

              {activeChangeFile ? (
                <div className="code-panel">
                  <div>
                    <div className="muted" style={{ marginBottom: 8 }}>
                      变更前
                    </div>
                    <pre className="code-block mono">
                      {activeChangeFile.before_content ?? (activeChangeFile.status === 'create' ? '[新文件]' : '[无可展示内容]')}
                    </pre>
                  </div>
                  <div>
                    <div className="muted" style={{ marginBottom: 8 }}>
                      变更后
                    </div>
                    <pre className="code-block mono">
                      {activeChangeFile.after_content ?? (activeChangeFile.status === 'delete' ? '[文件删除]' : '[无可展示内容]')}
                    </pre>
                  </div>
                </div>
              ) : null}

              <div>
                <div className="muted" style={{ marginBottom: 8 }}>
                  统一 diff 视图
                </div>
                <pre className="diff mono">{detail.changeSet.diff_text}</pre>
              </div>

              {detail.changeSet.status === 'awaiting_approval' ? (
                <div className="page-stack">
                  <label className="field" style={{ alignItems: 'flex-start' }}>
                    <span>应用方式</span>
                    <label className="button-row" style={{ alignItems: 'center' }}>
                      <input type="checkbox" checked={runTests} onChange={(event) => setRunTests(event.target.checked)} />
                      <span>应用文件后执行已配置的测试</span>
                    </label>
                  </label>
                  <div className="button-row">
                    <button className="button button--primary" onClick={() => void approveCurrent(runTests)}>
                      批准并应用
                    </button>
                    <button className="button button--warning" onClick={() => setDialog('reject')}>
                      拒绝
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </motion.section>

        <motion.section
          className="glass-card glass-card--deep bento-item bento-item--span-2"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.2 }}
        >
          <h3 className="section-title">实时日志与控制</h3>
          <AgentLogViewer events={events} selectedRunId={selectedRunId} />
          <div style={{ marginTop: 16 }}>
            <AgentControlPanel
              agentRun={selectedRun}
              onControlSent={async function () {
                await fetchSessionDetail(sessionId);
                if (selectedRun?.id) {
                  await fetchAgentEvents(selectedRun.id);
                }
              }}
            />
          </div>
        </motion.section>
      </div>

      <ConfirmDialog
        open={dialog === 'reject'}
        title="拒绝变更集"
        message="拒绝后会话将被中止，并且不会改动工作区文件。"
        variant="warning"
        confirmLabel="确认拒绝"
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          setDialog(null);
          void rejectCurrent();
        }}
      />
      <ConfirmDialog
        open={dialog === 'abort'}
        title="中止会话"
        message="中止会停止当前工作会话，并将其标记为已中止。"
        confirmLabel="确认中止"
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          setDialog(null);
          void abortCurrent();
        }}
      />
    </div>
  );
}
