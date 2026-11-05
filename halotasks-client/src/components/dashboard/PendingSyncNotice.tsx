type PendingSyncNoticeProps = {
  pendingCount: number;
  isOnline: boolean;
  syncing: boolean;
  onRetry: () => void;
};

/**
 * A compact "changes are waiting" line with a retry, shown whenever something is queued. The full sync status row lives
 * inside the collapsible Filters panel; without this, a person with pending work would have to open Filters to find out
 * or to retry. Renders nothing when the queue is empty.
 */
export default function PendingSyncNotice({ pendingCount, isOnline, syncing, onRetry }: PendingSyncNoticeProps) {
  if (pendingCount <= 0) return null;
  const noun = pendingCount === 1 ? 'change' : 'changes';
  return (
    <div className="pending-sync-notice" role="status">
      <span>
        {pendingCount} {noun} waiting to sync{isOnline ? '' : ' (you are offline)'}
      </span>
      {isOnline && (
        <button type="button" className="ghost-btn btn-sm" onClick={onRetry} disabled={syncing}>
          {syncing ? 'Syncing...' : 'Sync now'}
        </button>
      )}
    </div>
  );
}
