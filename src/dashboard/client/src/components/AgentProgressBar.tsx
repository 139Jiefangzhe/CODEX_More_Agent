export function AgentProgressBar({ current, total }: { current: number; total: number | null }) {
  const progress = total && total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 100;

  return (
    <div>
      <div className="progress">
        <div className="progress__fill" style={{ width: progress + '%' }} />
      </div>
      <div className="muted" style={{ marginTop: 6 }}>{total ? current + ' / ' + total : '执行中'}</div>
    </div>
  );
}
