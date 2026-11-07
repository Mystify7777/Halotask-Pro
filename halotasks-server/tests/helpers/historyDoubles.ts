// An in-memory stand-in for the legacy DayHistory model (only what the history controller uses). Rows are plain objects:
// { userId, date, completedCount, workDoneMinutes, completedTasks, updatedAt }.
export type LegacyRow = Record<string, unknown>;

export type LegacyStore = { rows: LegacyRow[]; finds: { userId: string; dates: string[] }[]; model: object };

export const createLegacyStore = (): LegacyStore => {
  const store: LegacyStore = { rows: [], finds: [], model: {} };
  store.model = {
    find: (filter: { userId: string; date: { $in: string[] } }) => {
      store.finds.push({ userId: String(filter.userId), dates: [...filter.date.$in] });
      const q = { lean: async () => store.rows.filter((r) => String(r.userId) === String(filter.userId) && filter.date.$in.includes(r.date as string)) };
      return q;
    },
    findOneAndUpdate: async (filter: { userId: string; date: string }, update: { $set: Record<string, unknown> }) => {
      const at = store.rows.findIndex((r) => String(r.userId) === String(filter.userId) && r.date === filter.date);
      const row = { userId: filter.userId, date: filter.date, updatedAt: new Date(), ...(at >= 0 ? store.rows[at] : {}), ...update.$set };
      if (at >= 0) store.rows[at] = row;
      else store.rows.push(row);
      return row;
    },
  };
  return store;
};
