import { getStatusLabel } from '../utils/labels';
import { getStatusTone } from '../utils/status-tone';

export function AgentStatusBadge({ status }: { status: string }) {
  const tone = getStatusTone(status);

  return (
    <span className={'status-pill status-pill--' + tone}>
      <span className="status-pill__dot" aria-hidden="true" />
      {getStatusLabel(status)}
    </span>
  );
}
