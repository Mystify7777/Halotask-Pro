import { getStageEmoji, getStageDescription, getStageProgressForXp, getTodayDate, daysBetween } from '../../growth/treeLogic';
import type { TreeState, TreeHealth } from '../../growth/treeTypes';
import styles from './GrowthTree.module.css';

interface GrowthTreeProps {
  state: TreeState;
}

/**
 * GrowthTree Widget
 * 
 * Displays current tree state with:
 * - Stage visualization (seed → lush)
 * - Health indicator
 * - Streak tracking
 * - XP progress
 * 
 * Minimal, premium design. Emotionally resonant, not gamified.
 */
export const GrowthTree: React.FC<GrowthTreeProps> = ({ state }) => {

  const healthColor: Record<TreeHealth, string> = {
    healthy: '#22c55e',
    wilting: '#eab308',
    dead: '#ef4444',
  };

  const healthLabel: Record<TreeHealth, string> = {
    healthy: 'Healthy',
    wilting: 'Wilting',
    dead: 'Needs Care',
  };

  // Calculate days since last activity
  const daysSinceActive = daysBetween(state.lastActiveDate, getTodayDate());
  const streakStatus = daysSinceActive === 0 ? 'Active Today' : `${daysSinceActive}d since last`;
  const stageProgress = getStageProgressForXp(state.xp);
  const progressLabel = stageProgress.nextStage
    ? `${getStageDescription(stageProgress.currentStage)} -> ${getStageDescription(stageProgress.nextStage)} (${stageProgress.nextThreshold} XP)`
    : `${getStageDescription(stageProgress.currentStage)} (Max stage)`;
  const progressPercentDisplay = `${stageProgress.progressPercent.toFixed(1)}%`;

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

        {/* Health Indicator */}
        <div className={styles.healthRow}>
          <span className={styles.healthLabel}>Health</span>
          <div
            className={styles.healthDot}
            style={{ backgroundColor: healthColor[state.health] }}
            title={healthLabel[state.health]}
          />
          <span className={styles.healthText}>{healthLabel[state.health]}</span>
        </div>

        {/* Streak Counter */}
        <div className={styles.statRow}>
          <span className={styles.statLabel}>Streak</span>
          <span className={styles.statValue}>{state.streakDays} days</span>
          <span className={styles.statHint}>{streakStatus}</span>
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
        </div>
      </div>

      {/* Footer Message */}
      <div className={styles.footer}>
        {state.streakDays > 0 && (
          <p className={styles.message}>
            Keep completing tasks to grow your tree and build a streak.
          </p>
        )}
        {state.streakDays === 0 && state.xp === 0 && (
          <p className={styles.message}>Complete your first task to plant a seed.</p>
        )}
      </div>
    </div>
  );
};

export default GrowthTree;
