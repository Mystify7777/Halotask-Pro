import type { ReactNode } from 'react';

type DisclosureToggleProps = {
  /** Visible text. It names the thing that opens and closes; the state is carried by aria-expanded and the chevron, never by this text. */
  label: string;
  expanded: boolean;
  onToggle: () => void;
  /** id of the region this button controls. Pass it only while that region is in the DOM. */
  controls?: string;
  /** Accessible name when the visible text alone is not enough (for example, a task card's details name the task). */
  ariaLabel?: string;
  /** A count or similar, shown after the label (aria-hidden: put it in `ariaLabel` if it matters to a screen reader). */
  badge?: ReactNode;
  /** Something inside the collapsed region needs attention (an active filter): a dot, plus this text for screen readers. */
  attention?: string;
  /**
   * toolbar: a bordered control in the search panel (Filters, Summary).
   * row:     a full-width bar that opens a section (Completed).
   * inline:  a quiet control inside a card (Details).
   */
  variant?: 'toolbar' | 'row' | 'inline';
};

/**
 * The one look for every show/hide control on the dashboard (Issue #11). It changes how the control looks and is announced,
 * not what it does: each caller still owns its own open/closed state and its own region. The chevron is drawn in CSS and is
 * hidden from assistive technology, so the state is announced once, through aria-expanded.
 */
export default function DisclosureToggle({
  label,
  expanded,
  onToggle,
  controls,
  ariaLabel,
  badge,
  attention,
  variant = 'toolbar',
}: DisclosureToggleProps) {
  return (
    <button
      type="button"
      className={`disclosure-toggle disclosure-toggle--${variant}`}
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-label={ariaLabel}
    >
      <span className="disclosure-chevron" aria-hidden="true" />
      <span className="disclosure-label">{label}</span>
      {attention && (
        <>
          <span className="disclosure-attention" aria-hidden="true" />
          <span className="visually-hidden">{attention}</span>
        </>
      )}
      {badge !== undefined && badge !== null && (
        <span className="disclosure-badge" aria-hidden="true">
          {badge}
        </span>
      )}
    </button>
  );
}
