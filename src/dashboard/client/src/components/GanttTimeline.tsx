import { getAgentLabel, getStatusLabel } from '../utils/labels';

export function GanttTimeline({
  timeline,
  onBarClick,
}: {
  timeline: any[];
  onBarClick?: (runId: string) => void;
}) {
  if (!timeline.length) {
    return <div className="empty-state">暂无时间线数据。</div>;
  }

  const now = Date.now();
  const starts = timeline
    .map(function (entry) {
      return Date.parse(entry.startedAt || '');
    })
    .filter(Number.isFinite);
  const ends = timeline
    .map(function (entry) {
      return entry.finishedAt ? Date.parse(entry.finishedAt) : now;
    })
    .filter(Number.isFinite);
  const minTime = Math.min(...starts);
  const maxTime = Math.max(...ends);
  const totalDuration = Math.max(maxTime - minTime, 1000);

  return (
    <div className="timeline">
      {timeline.map(function (entry) {
        const start = Date.parse(entry.startedAt || '');
        const end = entry.finishedAt ? Date.parse(entry.finishedAt) : now;
        const left = Number((((start - minTime) / totalDuration) * 100).toFixed(2));
        const width = Number((((Math.max(end - start, 500) / totalDuration) * 100)).toFixed(2));
        const duration = entry.durationSeconds ?? Number((Math.max(end - start, 0) / 1000).toFixed(2));

        return (
          <div key={entry.agentRunId} className="timeline__row">
            <div className="timeline__meta">
              <strong>{getAgentLabel(entry.agentType)}</strong>
              <span className="muted mono">{entry.agentRunId}</span>
              <span className="muted">状态：{getStatusLabel(entry.status)}</span>
              <span className="muted">耗时：{duration}s</span>
            </div>
            <div className="timeline__track">
              <button
                className={'timeline__bar timeline__bar--' + entry.status}
                style={{ left: left + '%', width: width + '%' }}
                onClick={() => onBarClick?.(entry.agentRunId)}
                title={entry.startedAt + ' -> ' + (entry.finishedAt || 'running')}
              >
                <span className="mono">{entry.trigger}</span>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
