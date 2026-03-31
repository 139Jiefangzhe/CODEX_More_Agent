export function EmptyState({ title, description, action }: { title: string; description?: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="empty-state">
      <h3 className="card-title" style={{ marginBottom: 10 }}>{title}</h3>
      {description ? <p className="card-subtitle">{description}</p> : null}
      {action ? (
        <div className="button-row" style={{ justifyContent: 'center', marginTop: 18 }}>
          <button className="button button--primary" onClick={action.onClick}>{action.label}</button>
        </div>
      ) : null}
    </div>
  );
}
