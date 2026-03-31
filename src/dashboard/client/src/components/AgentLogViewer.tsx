import { getEventTypeLabel } from '../utils/labels';
import { formatEventData } from '../utils/presentation';

export function AgentLogViewer({ events, selectedRunId }: { events: any[]; selectedRunId: string | null }) {
  const filtered = selectedRunId ? events.filter((event) => event.agent_run_id === selectedRunId) : events;

  return (
    <div className="log-viewer">
      <div className="log-viewer__toolbar">
        <strong>事件日志</strong>
        <span className="muted">{filtered.length} 条事件</span>
      </div>
      <div className="log-viewer__body">
        {filtered.length === 0 ? <div className="muted">暂无事件。</div> : null}
        {filtered.map(function (event) {
          const content = formatEventData(event.event_type, event.event_data);
          const isTextContent = typeof content === 'string';

          return (
            <div key={event.id + '-' + event.timestamp} className="log-line">
              <div className="log-line__meta mono">
                <span>{event.timestamp}</span>
                <span>{getEventTypeLabel(event.event_type)}</span>
                <span>{event.agent_run_id}</span>
              </div>
              {isTextContent ? (
                <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{content}</pre>
              ) : (
                <div className="log-line__content">{content}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
