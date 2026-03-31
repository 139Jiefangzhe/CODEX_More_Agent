export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export function getStatusTone(status: string): StatusTone {
  const normalized = String(status || '').trim().toLowerCase();

  if (
    normalized === 'running' ||
    normalized === 'planning' ||
    normalized === 'implementing' ||
    normalized === 'reviewing' ||
    normalized === 'applying' ||
    normalized === 'testing' ||
    normalized === 'completed' ||
    normalized === 'approved' ||
    normalized === 'applied'
  ) {
    return 'success';
  }

  if (
    normalized === 'pending' ||
    normalized === 'paused' ||
    normalized === 'awaiting_approval' ||
    normalized === 'retrying' ||
    normalized === 'draft' ||
    normalized === 'skipped'
  ) {
    return 'warning';
  }

  if (
    normalized === 'failed' ||
    normalized === 'aborted' ||
    normalized === 'rejected' ||
    normalized === 'apply_failed' ||
    normalized === 'test_failed'
  ) {
    return 'danger';
  }

  if (normalized === 'connecting' || normalized === 'connected') {
    return 'info';
  }

  if (normalized === 'disconnected') {
    return 'danger';
  }

  return 'neutral';
}
