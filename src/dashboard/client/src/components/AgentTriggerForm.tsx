import { useEffect, useMemo, useState } from 'react';

import { api } from '../api/client';
import { getAgentLabel } from '../utils/labels';

const AGENT_TYPES = ['architect', 'coder', 'reviewer', 'tester', 'devops', 'security', 'uiux'];

export function AgentTriggerForm({
  agentType,
  projects,
  onCancel,
  onTriggered,
}: {
  agentType?: string;
  projects: any[];
  onCancel?: () => void;
  onTriggered?: (result: { sessionId: string; agentRunId: string }) => void;
}) {
  const [selectedAgent, setSelectedAgent] = useState(agentType || 'architect');
  const [projectId, setProjectId] = useState('');
  const [args, setArgs] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const locked = Boolean(agentType);
  const canSubmit = Boolean(projectId && args.trim() && selectedAgent && !loading);

  useEffect(function () {
    if (projects.length === 0) {
      setProjectId('');
      return;
    }

    setProjectId(function (current) {
      if (current && projects.some((project) => project.id === current)) {
        return current;
      }

      return projects[0].id;
    });
  }, [projects]);

  useEffect(function () {
    if (!agentType) {
      return;
    }

    setSelectedAgent(agentType);
  }, [agentType]);

  const placeholder = useMemo(
    function () {
      switch (selectedAgent) {
        case 'architect':
          return '例如：为支付模块增加分层架构设计，输出核心接口与约束。';
        case 'coder':
          return '例如：实现用户设置 API 与前端页面，包含输入校验与错误处理。';
        case 'reviewer':
          return '例如：对最近改动做正确性与风险评审，给出通过建议。';
        case 'tester':
          return '例如：为会话审批流程补充集成测试与失败场景。';
        case 'devops':
          return '例如：给出 CI/CD 流水线优化建议与可执行脚本草案。';
        case 'security':
          return '例如：审查当前 API 鉴权与敏感信息暴露风险并给出修复建议。';
        case 'uiux':
          return '例如：优化会话详情页信息层次与移动端可读性。';
        default:
          return '描述你希望该 Agent 执行的任务。';
      }
    },
    [selectedAgent],
  );

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!canSubmit) {
      return;
    }

    setLoading(true);
    setError('');

    try {
      const result = await api.trigger.agent({
        projectId,
        agent: selectedAgent,
        args: args.trim(),
      });
      onTriggered?.(result);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="page-stack" onSubmit={handleSubmit}>
      <label className="field">
        <span>Agent 类型</span>
        <select
          className="select"
          value={selectedAgent}
          disabled={locked || loading}
          onChange={(event) => setSelectedAgent(event.target.value)}
        >
          {AGENT_TYPES.map(function (type) {
            return (
              <option key={type} value={type}>
                {getAgentLabel(type)}
              </option>
            );
          })}
        </select>
      </label>

      <label className="field">
        <span>项目</span>
        <select
          className="select"
          value={projectId}
          disabled={loading}
          onChange={(event) => setProjectId(event.target.value)}
        >
          {projects.map(function (project) {
            return (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            );
          })}
        </select>
      </label>

      <label className="field">
        <span>任务参数</span>
        <textarea
          className="textarea"
          placeholder={placeholder}
          value={args}
          onChange={(event) => setArgs(event.target.value)}
          disabled={loading}
        />
      </label>

      {error ? <div className="notice notice--error">{error}</div> : null}

      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={!canSubmit}>
          {loading ? '触发中...' : '触发任务'}
        </button>
        {onCancel ? (
          <button type="button" className="button button--ghost" disabled={loading} onClick={onCancel}>
            取消
          </button>
        ) : null}
      </div>
    </form>
  );
}
