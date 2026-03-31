export function ConfirmDialog({ open, title, message, confirmLabel = '确认', cancelLabel = '取消', variant = 'danger', onConfirm, onCancel }: any) {
  if (!open) {
    return null;
  }

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal__panel">
        <h3 className="card-title">{title}</h3>
        <p className="card-subtitle">{message}</p>
        <div className="button-row" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
          <button className="button button--ghost" onClick={onCancel}>{cancelLabel}</button>
          <button className={'button ' + (variant === 'warning' ? 'button--warning' : 'button--danger')} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
