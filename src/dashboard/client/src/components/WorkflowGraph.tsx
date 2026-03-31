import { AgentProgressBar } from './AgentProgressBar';
import { AgentStatusBadge } from './AgentStatusBadge';
import { getAgentLabel } from '../utils/labels';

export function WorkflowGraph({ agentRuns, onNodeClick }: any) {
  return (
    <div className="workflow">
      {agentRuns.map(function (run: any) {
        return (
          <button key={run.id} className="workflow__node" onClick={() => onNodeClick(run.id)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <div>
                <strong style={{ display: 'block', fontSize: 18 }}>{getAgentLabel(run.agent_type)}</strong>
                <div className="muted mono">{run.id}</div>
              </div>
              <AgentStatusBadge status={run.status} />
            </div>
            <AgentProgressBar current={run.step_current} total={run.step_total} />
          </button>
        );
      })}
    </div>
  );
}
