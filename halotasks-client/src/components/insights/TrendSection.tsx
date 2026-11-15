import { useMemo, useState } from 'react';
import {
  RANGE_LABEL,
  comparisonText,
  coverageNote,
  dayLabel,
  formatDateKey,
  formatMinutes,
  headline,
  patternNote,
  shortWeekday,
} from '../../insights/copy';
import type { DayTask } from '../../insights/dayPoints';
import { TREND_RANGES, buildTrend, weekdayAverages, type DayPoint, type TrendRange, type WeekBucket } from '../../insights/trend';
import type { TrendHistory } from '../../insights/trendHistory';

type Props = {
  /** null while the first load is in flight. */
  history: TrendHistory | null;
  /** The load failed in a way the reader does not cover (it normally never does). */
  failed: boolean;
  range: TrendRange;
  onRangeChange: (range: TrendRange) => void;
  onRetry: () => void;
};

const percent = (value: number, max: number): number => (max <= 0 ? 0 : (value / max) * 100);

function Chip({ icon, value, label, note }: { icon: string; value: string; label: string; note?: string }) {
  return (
    <div className="insights-weekly-chip">
      <span className="insights-weekly-chip-icon" aria-hidden="true">{icon}</span>
      <div>
        <strong className="insights-weekly-chip-value">{value}</strong>
        <span className="insights-weekly-chip-label">{label}</span>
        {note && <span className="insights-weekly-chip-label">{note}</span>}
      </div>
    </div>
  );
}

/** One bar per day (7 and 30 days) or per week (90 days). Unknown days are drawn as an empty dashed slot, never as zero. */
function Bars({ points, weeks, range }: { points: DayPoint[]; weeks: WeekBucket[]; range: TrendRange }) {
  if (range === 90) {
    const max = Math.max(...weeks.map((w) => w.completed), 1);
    return (
      <div className="trend-bars" style={{ gridTemplateColumns: `repeat(${weeks.length}, 1fr)` }} aria-hidden="true">
        {weeks.map((w) => (
          <span key={w.startDate} className="trend-bar-slot" title={`${formatDateKey(w.startDate)} to ${formatDateKey(w.endDate)}`}>
            <span
              className={`trend-bar${w.knownDays === 0 ? ' unknown' : ''}${w.complete ? '' : ' partial'}`}
              style={{ height: `${w.knownDays === 0 ? 100 : Math.max(percent(w.completed, max), w.completed > 0 ? 6 : 2)}%` }}
            />
          </span>
        ))}
      </div>
    );
  }
  const max = Math.max(...points.map((p) => p.completed), 1);
  return (
    <div className="trend-bars" style={{ gridTemplateColumns: `repeat(${points.length}, 1fr)` }} aria-hidden="true">
      {points.map((p) => (
        <span key={p.date} className="trend-bar-slot">
          <span
            className={`trend-bar${p.known ? '' : ' unknown'}`}
            style={{ height: `${p.known ? Math.max(percent(p.completed, max), p.completed > 0 ? 6 : 2) : 100}%` }}
          />
        </span>
      ))}
    </div>
  );
}

/** The 7-day view keeps the existing day buttons and the selected day's task list. */
function WeekDays({
  points,
  today,
  tasksByDate,
}: {
  points: DayPoint[];
  today: string;
  tasksByDate: Record<string, DayTask[]>;
}) {
  const [selected, setSelected] = useState<string | null>(today);
  const max = Math.max(...points.map((p) => p.completed), 1);
  const day = points.find((p) => p.date === selected) ?? null;
  const listed = selected ? (tasksByDate[selected] ?? []) : [];

  return (
    <div className="week-history">
      <ul className="week-history-bars" aria-label="Completions per day">
        {points.map((p) => {
          const isToday = p.date === today;
          const active = p.date === selected;
          const label = `${shortWeekday(p.date)}${isToday ? ' (today)' : ''}: ${p.known ? `${p.completed} ${p.completed === 1 ? 'task' : 'tasks'}` : 'no history'}`;
          return (
            <li key={p.date}>
              <button
                type="button"
                className={`week-history-day${active ? ' active' : ''}${isToday ? ' today' : ''}`}
                onClick={() => setSelected(active ? null : p.date)}
                aria-label={label}
                aria-pressed={active}
              >
                <span className="week-history-bar-wrap">
                  <span
                    className={`week-history-bar${p.known ? '' : ' unknown'}`}
                    style={{ height: `${p.known ? Math.max(percent(p.completed, max), p.completed > 0 ? 8 : 2) : 100}%` }}
                  />
                </span>
                <span className="week-history-count">{p.known ? p.completed : '–'}</span>
                <span className="week-history-label">{shortWeekday(p.date)}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {day && (
        <div className="week-history-detail">
          <p className="week-history-detail-header">
            <strong>{dayLabel(day.date, today)}</strong>
            {day.known && day.minutes > 0 && <span className="week-history-time">⏱️ {formatMinutes(day.minutes)}</span>}
          </p>
          {!day.known ? (
            <p className="setting-desc">No history was recorded for this day.</p>
          ) : listed.length === 0 ? (
            <p className="setting-desc">{day.completed > 0 ? `${day.completed} completed; no task names were kept for this day.` : 'No tasks completed this day.'}</p>
          ) : (
            <ul className="week-history-tasks">
              {listed.map((task) => (
                <li key={task.id} className="week-history-task">
                  <span className="week-history-task-check" aria-hidden="true">✓</span>
                  <span className="week-history-task-title">{task.title}</span>
                  {task.estimatedMinutes > 0 && <span className="week-history-task-time">{formatMinutes(task.estimatedMinutes)}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Every number the chart draws, as a table: the screen-reader and keyboard route to the data. */
function DataTable({ points, weeks, range }: { points: DayPoint[]; weeks: WeekBucket[]; range: TrendRange }) {
  const weekly = range === 90;
  return (
    <details className="trend-table">
      <summary>View as table</summary>
      <table>
        <caption className="visually-hidden">{RANGE_LABEL[range]}: tasks completed {weekly ? 'per week' : 'per day'}</caption>
        <thead>
          <tr>
            <th scope="col">{weekly ? 'Week' : 'Day'}</th>
            <th scope="col">Completed</th>
            <th scope="col">Work done</th>
          </tr>
        </thead>
        <tbody>
          {weekly
            ? [...weeks].reverse().map((w) => (
                <tr key={w.startDate}>
                  <th scope="row">{formatDateKey(w.startDate)} to {formatDateKey(w.endDate)}</th>
                  <td>{w.knownDays === 0 ? 'No history' : w.completed}</td>
                  <td>{w.knownDays === 0 ? '–' : formatMinutes(w.minutes)}</td>
                </tr>
              ))
            : [...points].reverse().map((p) => (
                <tr key={p.date}>
                  <th scope="row">{formatDateKey(p.date, { weekday: 'short', month: 'short', day: 'numeric' })}</th>
                  <td>{p.known ? p.completed : 'No history'}</td>
                  <td>{p.known ? formatMinutes(p.minutes) : '–'}</td>
                </tr>
              ))}
        </tbody>
      </table>
    </details>
  );
}

export default function TrendSection({ history, failed, range, onRangeChange, onRetry }: Props) {
  // Nobody signed in: nothing to show (the page sits behind sign-in, so this is only a guard).
  history = history && history.coverage === 'none' ? null : history;
  const deviceOnly = history?.coverage === 'device-only';
  const result = useMemo(() => (history && history.points.length > 0 ? buildTrend(history.points, range) : null), [history, range]);
  const pattern = useMemo(() => (history ? weekdayAverages(history.points) : null), [history]);
  const knownDays = useMemo(() => (history ? history.points.filter((p) => p.known).length : 0), [history]);

  return (
    <section className="settings-section panel" aria-labelledby="trend-heading">
      <div className="trend-header">
        <h2 id="trend-heading">Activity</h2>
        <div className="insights-range-toggle" role="group" aria-label="History range">
          {TREND_RANGES.map((r) => {
            const disabled = deviceOnly && r !== 7;
            return (
              <button
                key={r}
                type="button"
                className={`insights-range-btn${r === range ? ' active' : ''}`}
                aria-pressed={r === range}
                disabled={disabled}
                onClick={() => onRangeChange(r)}
              >
                {r} days
              </button>
            );
          })}
        </div>
      </div>

      {history === null && !failed && (
        <div className="insights-skeleton" aria-busy="true">
          <span className="visually-hidden" role="status">Loading your history…</span>
          <span className="insights-skeleton-line" />
          <span className="insights-skeleton-bars" />
        </div>
      )}

      {failed && (
        <p className="trend-note" role="status">
          We couldn&apos;t load your history. <button type="button" className="ghost-btn btn-sm" onClick={onRetry}>Try again</button>
        </p>
      )}

      {history && history.coverage === 'device-only' && <p className="trend-note" role="status">{coverageNote(history.reason)}</p>}

      {history && history.points.length === 0 && (
        <p className="setting-desc">
          Nothing is saved on this device yet. <button type="button" className="ghost-btn btn-sm" onClick={onRetry}>Try again</button>
        </p>
      )}

      {history && result && result.status === 'invalid' && (
        <p className="trend-note" role="status">
          We couldn&apos;t read your history right now. <button type="button" className="ghost-btn btn-sm" onClick={onRetry}>Try again</button>
        </p>
      )}

      {history && result && result.status !== 'invalid' && (
        <>
          <p className="trend-headline" aria-live="polite">{headline(result)}</p>

          {(result.status === 'complete' || result.status === 'partial') && (
            <>
              <p className="setting-desc">{comparisonText(result.comparison, range)}</p>

              <div className="insights-weekly-summary">
                <Chip icon="✅" value={String(result.summary.completed)} label="completed" />
                <Chip icon="📆" value={`${result.summary.activeDays} of ${result.summary.knownDays}`} label="active days" />
                <Chip icon="⏱️" value={formatMinutes(result.summary.minutes)} label="work done" />
                {result.summary.bestDay && (
                  <Chip
                    icon="🏆"
                    value={formatDateKey(result.summary.bestDay.date)}
                    label="best day"
                    note={`${result.summary.bestDay.completed} ${result.summary.bestDay.completed === 1 ? 'task' : 'tasks'}`}
                  />
                )}
              </div>

              {range === 7 ? (
                <WeekDays points={result.window} today={history.today} tasksByDate={history.tasksByDate} />
              ) : (
                <>
                  <Bars points={result.window} weeks={result.weeks} range={range} />
                  <div className="trend-axis" aria-hidden="true">
                    <span>{formatDateKey(result.window[0].date)}</span>
                    <span>Today</span>
                  </div>
                </>
              )}
              {range !== 7 && <DataTable points={result.window} weeks={result.weeks} range={range} />}
            </>
          )}

          {pattern && pattern.status === 'ok' && pattern.leaders.length > 0 && (
            <div className="insights-pattern" role="note">
              <span className="insights-pattern-icon" aria-hidden="true">💡</span>
              <p className="insights-pattern-text">{patternNote(pattern.leaders, knownDays)}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
