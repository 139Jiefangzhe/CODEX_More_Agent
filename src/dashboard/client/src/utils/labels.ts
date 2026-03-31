const AGENT_LABELS: Record<string, string> = {
  architect: '架构师',
  coder: '开发者',
  reviewer: '评审员',
  tester: '测试员',
  devops: '运维',
  security: '安全',
  uiux: '设计',
};

const STATUS_LABELS: Record<string, string> = {
  pending: '待开始',
  running: '进行中',
  paused: '已暂停',
  skipped: '已跳过',
  retrying: '重试中',
  completed: '已完成',
  failed: '失败',
  aborted: '已中止',
  approved: '已批准',
  rejected: '已拒绝',
  awaiting_approval: '待审批',
  applying: '应用中',
  testing: '测试中',
  planning: '规划中',
  implementing: '实现中',
  reviewing: '评审中',
  applied: '已应用',
  apply_failed: '应用失败',
  test_failed: '测试失败',
  draft: '草稿',
  create: '新建',
  modify: '修改',
};

const CONNECTION_STATUS_LABELS: Record<string, string> = {
  connected: '实时已连接',
  connecting: '重连中',
  disconnected: '未连接',
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  step_start: '步骤开始',
  step_end: '步骤完成',
  tool_call: '工具调用',
  output: '输出',
  error: '错误',
  checkpoint: '检查点',
  changeset: '变更集',
  system: '系统',
};

export function getAgentLabel(agentType: string) {
  return AGENT_LABELS[agentType] || agentType;
}

export function getStatusLabel(status: string) {
  return STATUS_LABELS[status] || status;
}

export function getConnectionStatusLabel(status: string) {
  return CONNECTION_STATUS_LABELS[status] || status;
}

export function getEventTypeLabel(eventType: string) {
  return EVENT_TYPE_LABELS[eventType] || eventType;
}
