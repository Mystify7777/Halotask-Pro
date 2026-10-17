import { getStageEmoji, getStageDescription, getStageProgressForXp, deriveTreeStatus, getStreakHint, TREE_STATUS_COPY } from '../../growth/treeLogic';
import type { TreeState, TreeHealth } from '../../growth/treeTypes';
import styles from './GrowthTree.module.css';

interface GrowthTreeProps {
  state: TreeState;
}

const HEALTH_COLOR: Record<TreeHealth, string> = {
  healthy: '#22c55e',
  wilting: '#eab308',
  dead: '#ef4444',
};

/**
 * GrowthTree Widget
 *
 * Displays current tree state: stage, health, streak, XP.
 * Shows a neutral "—" health state for brand-new users who haven't
 * done any tasks yet, rather than the misleading "Needs Care" label.
 */
export const GrowthTree: React.FC<GrowthTreeProps> = ({ state }) => {
  // Labels only: the server decides the status (GET /api/tree); this derives the same one from the cached state.
  const info = deriveTreeStatus(state.streakDays, state.lastActiveDate, state.xp);
  const copy = TREE_STATUS_COPY[info.status];
  const streakStatus = getStreakHint(info);

  const stageProgress = getStageProgressForXp(state.xp);
  const progressLabel = stageProgress.nextStage
    ? `${getStageDescription(stageProgress.currentStage)} → ${getStageDescription(stageProgress.nextStage)} (${stageProgress.nextThreshold} XP)`
    : `${getStageDescription(stageProgress.currentStage)} (Max stage)`;
  const progressPercentDisplay = `${stageProgress.progressPercent.toFixed(1)}%`;
  const xpHint = stageProgress.nextStage
    ? `${stageProgress.xpToNextStage} XP to ${getStageDescription(stageProgress.nextStage)}`
    : 'Maximum Growth Reached';

  // A brand-new user hasn't neglected anything: don't show the tree as "Needs Care", show it as unstarted.
  const isUnstarted = info.status === 'unstarted';

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <h2 className={styles.title}>🌳 Growth Tree</h2>
      </div>

      {/* Main Display */}
      <div className={styles.display}>
        {/* Emoji + Stage */}
        <div className={styles.stageSection}>
          <div className={styles.emoji}>{getStageEmoji(state.stage)}</div>
          <div className={styles.stageName}>{getStageDescription(state.stage)}</div>
        </div>

        {/* Health Indicator — hidden for unstarted users */}
        {!isUnstarted && (
          <div className={styles.healthRow}>
            <span className={styles.healthLabel}>Health</span>
            <div
              className={styles.healthDot}
              style={{ backgroundColor: HEALTH_COLOR[info.health] }}
              title={copy.healthLabel}
              aria-hidden="true"
            />
            <span className={styles.healthText}>{copy.healthLabel}</span>
          </div>
        )}

        {/* Streak Counter */}
        <div className={styles.statRow}>
          <span className={styles.statLabel}>Streak</span>
          <span className={styles.statValue}>{info.effectiveStreakDays} days</span>
          {streakStatus && (
            <span className={styles.statHint}>{streakStatus}</span>
          )}
        </div>

        {/* Leaves */}
        <div className={styles.statRow}>
          <span className={styles.statLabel}>Leaves</span>
          <span className={styles.statValue}>{state.leaves} 🍃</span>
        </div>

        {/* XP Progress */}
        <div className={styles.xpSection}>
          <div className={styles.xpHeader}>
            <span className={styles.xpLabel}>Experience</span>
            <span className={styles.xpValue}>{state.xp} XP</span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>Path</span>
            <span className={styles.statValue}>{progressLabel}</span>
            <span className={styles.statHint}>{progressPercentDisplay}</span>
          </div>
          <div className={styles.xpBar}>
            <div className={styles.xpFill} style={{ width: `${stageProgress.progressPercent}%` }} />
          </div>
          <p className={styles.xpHint}>{xpHint}</p>
        </div>
      </div>

      {/* Footer Message */}
      <div className={styles.footer}>
        <p className={styles.message}>{copy.message}</p>
      </div>
    </div>
  );
};

export default GrowthTree;
