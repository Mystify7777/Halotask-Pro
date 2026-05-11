import { getStageEmoji, getStageDescription, getStageProgressForXp, getTodayDate, daysBetween } from '../../growth/treeLogic';
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

const HEALTH_LABEL: Record<TreeHealth, string> = {
  healthy: 'Healthy',
  wilting: 'Wilting',
  dead: 'Needs Care',
};

function getFooterMessage(state: TreeState): string {
  // Brand-new user: no tasks ever done
  if (state.xp === 0 && state.streakDays === 0) {
    return 'Complete your first task to plant a seed.';
  }
  // Has XP but streak is currently 0 — streak broke
  if (state.streakDays === 0 && state.xp > 0) {
    return 'Your streak broke, but your progress remains. Complete a task to restart.';
  }
  // Active streak
  return 'Keep completing tasks to grow your tree and build a streak.';
}

/**
 * GrowthTree Widget
 *
 * Displays current tree state: stage, health, streak, XP.
 * Shows a neutral "—" health state for brand-new users who haven't
 * done any tasks yet, rather than the misleading "Needs Care" label.
 */
export const GrowthTree: React.FC<GrowthTreeProps> = ({ state }) => {
  const daysSinceActive = daysBetween(state.lastActiveDate, getTodayDate());
  const streakStatus = daysSinceActive === 0 ? 'Active Today' : `${daysSinceActive}d since last`;

  const stageProgress = getStageProgressForXp(state.xp);
  const progressLabel = stageProgress.nextStage
    ? `${getStageDescription(stageProgress.currentStage)} → ${getStageDescription(stageProgress.nextStage)} (${stageProgress.nextThreshold} XP)`
    : `${getStageDescription(stageProgress.currentStage)} (Max stage)`;
  const progressPercentDisplay = `${stageProgress.progressPercent.toFixed(1)}%`;
  const xpHint = stageProgress.nextStage
    ? `${stageProgress.xpToNextStage} XP to ${getStageDescription(stageProgress.nextStage)}`
    : 'Maximum Growth Reached';

  // A brand-new user (xp=0, streak=0) hasn't neglected anything —
  // don't show the tree as "dead/Needs Care", show it as unstarted.
  const isUnstarted = state.xp === 0 && state.streakDays === 0;

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
              style={{ backgroundColor: HEALTH_COLOR[state.health] }}
              title={HEALTH_LABEL[state.health]}
              aria-hidden="true"
            />
            <span className={styles.healthText}>{HEALTH_LABEL[state.health]}</span>
          </div>
        )}

        {/* Streak Counter */}
        <div className={styles.statRow}>
          <span className={styles.statLabel}>Streak</span>
          <span className={styles.statValue}>{state.streakDays} days</span>
          {!isUnstarted && (
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
        <p className={styles.message}>{getFooterMessage(state)}</p>
      </div>
    </div>
  );
};

export default GrowthTree;
