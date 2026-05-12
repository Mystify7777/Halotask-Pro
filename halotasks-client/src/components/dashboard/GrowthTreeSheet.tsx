import { useEffect, useRef } from 'react';
import type { TreeState } from '../../growth/treeTypes';
import GrowthTree from './GrowthTree';

type GrowthTreeSheetProps = {
  isOpen: boolean;
  onClose: () => void;
  treeState: TreeState;
};

export default function GrowthTreeSheet({ isOpen, onClose, treeState }: GrowthTreeSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // Focus the panel when it opens
  useEffect(() => {
    if (isOpen) sheetRef.current?.focus();
  }, [isOpen]);

  // Lock body scroll while open
  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      <div className="sheet-backdrop" aria-hidden="true" onClick={onClose} />

      <div
        ref={sheetRef}
        className="task-create-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Growth tree"
        tabIndex={-1}
      >
        <div className="sheet-handle" aria-hidden="true" />

        <div className="sheet-header">
          <h2 className="sheet-title">Growth Tree</h2>
          <button
            type="button"
            className="ghost-btn sheet-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="sheet-body">
          <GrowthTree state={treeState} />
        </div>
      </div>
    </>
  );
}
