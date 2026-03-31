import { useMemo, useState } from 'react';

import { api } from '../api/client';
import { getStatusLabel } from '../utils/labels';
import { ConfirmDialog } from './ConfirmDialog';

const ACTION_LABELS = {
  pause: '暂停',
  resume: '恢复',
  skip: '跳过',
  retry: '重试',
  abort: '终止',
};

export function AgentControlPanel({
  agentRun,
  onControlSent,
}: {
  agentRun: any | null;
  onControlSent?: (payload: any) => void;
}) {
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmAbort, setConfirmAbort] = useState(false);
  const trigger = String(agentRun?.trigger || '');
  const status = String(agentRun?.status || '');
  const actions = useMemo(
    function () {
      if (!agentRun) {
        return [];
      }

      return ['pause', 'resume', 'skip', 'retry', 'abort'].filter(function (action) {
        return isActionAvailable(action, status);
      });
    },
    [agentRun, status],
  );

  if (!agentRun) {
    return (
      <div className="page-stack">
        <h4 className="section-title">控制面板</h4>
        <p className="muted">选择一个执行节点后可发送控制指令。</p>
      </div>
    );
  }

  async function handleControl(action: string) {
    if (!agentRun?.id || loadingAction) {
      return;
    }

    setLoadingAction(action);
    setError('');
    setNotice('');

    try {
      const payload = await api.agents.control(agentRun.id, { action });
      setNotice('已发送指令：' + ACTION_LABELS[action] + '（模式：' + (payload?.mode || 'checkpoint') + '）');
      onControlSent?.(payload);
    } catch (controlError) {
      setError(controlError instanceof Error ? controlError.message : String(controlError));
    } finally {
      setLoadingAction(null);
    }
  }

  return (
    <div className="page-stack">
      <h4 className="section-title">控制面板</h4>
      <div className="muted">
        当前状态：{getStatusLabel(status)} · 触发来源：<span className="mono">{trigger || '-'}</span>
      </div>
      {actions.length === 0 ? <div className="muted">当前节点没有可发送的控制指令。</div> : null}
      {actions.length > 0 ? (
        <div className="button-row">
          {actions.map(function (action) {
            const isAbort = action === 'abort';
            const disabled = loadingAction !== null;
            return (
              <button
                key={action}
                className={'button ' + (isAbort ? 'button--danger' : action === 'skip' ? 'button--warning' : 'button--ghost')}
                disabled={disabled}
                onClick={() => {
                  if (isAbort) {
                    setConfirmAbort(true);
                    return;
                  }

                  void handleControl(action);
                }}
              >
                {loadingAction === action ? '处理中...' : ACTION_LABELS[action]}
              </button>
            );
          })}
        </div>
      ) : null}
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="notice notice--error">{error}</div> : null}

      <ConfirmDialog
        open={confirmAbort}
        title="确认终止节点"
        message="终止会话会尝试取消当前执行并将会话标记为已中止。"
        confirmLabel="确认终止"
        onCancel={() => setConfirmAbort(false)}
        onConfirm={() => {
          setConfirmAbort(false);
          void handleControl('abort');
        }}
      />
    </div>
  );
}

function isActionAvailable(action: string, status: string) {
  if (action === 'pause') {
    return status === 'running';
  }

  if (action === 'resume') {
    return status === 'paused';
  }

  if (action === 'skip') {
    return status === 'pending' || status === 'running' || status === 'paused';
  }

  if (action === 'retry') {
    return status === 'completed' || status === 'failed' || status === 'aborted' || status === 'skipped';
  }

  if (action === 'abort') {
    return status === 'pending' || status === 'running' || status === 'paused';
  }

  return false;
}
