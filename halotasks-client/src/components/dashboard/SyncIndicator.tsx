import type { RejectionNotice } from '../../hooks/useDashboardSync';
import type { SyncState } from '../../offline/syncState';

type SyncIndicatorProps = {
  state: SyncState;
  rejections: RejectionNotice[];
  retrying: boolean;
  onRetry: () => void;
  onDismiss: () => void;
};

const changes = (count: number) => `${count} ${count === 1 ? 'change' : 'changes'}`;

/**
 * The one always-visible line about synchronization (Issue #58). It renders the state `deriveSyncState` produced and decides
 * nothing: the wording says only what the state can prove. "Synced" means the server accepted every change this device
 * queued; "stored on this device" is said whenever the work has not been sent. Quiet (nothing at all) when the app was just
 * opened and has not synchronized yet, because then there is nothing true to say.
 */
export default function SyncIndicator({ state, rejections, retrying, onRetry, onDismiss }: SyncIndicatorProps) {
  if (state.kind === 'unverified') return null;

  if (state.kind === 'attention') {
    return (
      <div className="sync-indicator attention" role="status">
        <div className="sync-indicator-lines">
          {rejections.map((notice, index) => (
            <span key={index}>{notice.message}</span>
          ))}
          {state.blocked === 'unreachable' && (
            <span>Couldn’t sync with the server. {changes(state.pending)} kept on this device.</span>
          )}
          {state.blocked === 'auth' && <span>Sign in again to sync {changes(state.pending)}. They are kept on this device.</span>}
        </div>
        {state.blocked === 'unreachable' && (
          <button type="button" className="ghost-btn btn-sm" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Retrying...' : 'Retry'}
          </button>
        )}
        {rejections.length > 0 && (
          <button type="button" className="ghost-btn btn-sm" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
    );
  }

  if (state.kind === 'syncing') {
    return (
      <div className="sync-indicator syncing" role="status">
        <span>Syncing {changes(state.pending)}…</span>
      </div>
    );
  }

  if (state.kind === 'offline') {
    return (
      <div className="sync-indicator offline" role="status">
        <span>{state.pending > 0 ? `Offline. ${changes(state.pending)} stored on this device.` : 'Offline'}</span>
      </div>
    );
  }

  if (state.kind === 'pending') {
    return (
      <div className="sync-indicator pending" role="status">
        <span>{changes(state.pending)} not synced yet</span>
        <button type="button" className="ghost-btn btn-sm" onClick={onRetry} disabled={retrying}>
          {retrying ? 'Syncing...' : 'Sync now'}
        </button>
      </div>
    );
  }

  return (
    <div className="sync-indicator synced" role="status">
      <span>
        Synced {state.confirmedAt ? new Date(state.confirmedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
      </span>
    </div>
  );
}
