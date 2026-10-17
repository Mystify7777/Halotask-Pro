import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import User from '../src/models/User.model';
import { awardTaskCompletion } from '../src/utils/treeAward';

// Issue #24 — the award talks to MongoDB through Mongoose, which casts filters and updates and applies the
// schema's strict mode before anything is sent. This file runs the REAL `User` model and the REAL
// treeAward code, and intercepts only the driver call underneath, so it asserts the exact command Mongoose
// would put on the wire — no database needed. It is what guards against Mongoose silently rewriting the
// atomic filter (e.g. stripping the array-index path) or dropping an `$inc`/`$push`.

type Command = { method: string; filter: Record<string, unknown>; update?: Record<string, unknown>; options?: Record<string, unknown> };

const sent: Command[] = [];
const USER_ID = '665f1c2e9b1e8a00000000aa';
const TASK_ID = '507f1f77bcf86cd799439011';
const NOW_ISO = '2026-10-06T10:00:00.000Z';

/** Mongoose's own timestamp bookkeeping (`timestamps: true`), which rides along on every update. */
const withoutTimestamps = (update: Record<string, unknown> | undefined) => {
  const { $set, $setOnInsert, ...rest } = (update ?? {}) as { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> };
  const set = Object.fromEntries(Object.entries($set ?? {}).filter(([key]) => key !== 'updatedAt'));
  const insert = Object.fromEntries(Object.entries($setOnInsert ?? {}).filter(([key]) => key !== 'createdAt'));
  return { ...rest, ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(insert).length ? { $setOnInsert: insert } : {}) };
};

const stored = (over: Record<string, unknown> = {}) => ({
  treeState: { xp: 100, streakDays: 3, lastActiveDate: '2026-10-05', awardedTaskIds: ['older'], activeDays: ['2026-10-03', '2026-10-04', '2026-10-05'], ...over },
});

beforeEach(() => {
  sent.length = 0;

  const collection = User.collection as unknown as Record<string, unknown>;
  const record = (method: string, answer: (c: Command) => unknown) =>
    async (filter: Record<string, unknown>, update?: Record<string, unknown>, options?: Record<string, unknown>) => {
      const command = { method, filter, update, options };
      sent.push(command);
      return answer(command);
    };

  // 1st findOneAndUpdate = the award (answer with the post-$inc doc), 2nd = the pinned derived write.
  let findOneAndUpdateCalls = 0;
  collection.findOneAndUpdate = async (filter: Record<string, unknown>, update: Record<string, unknown>, options: Record<string, unknown>) => {
    sent.push({ method: 'findOneAndUpdate', filter, update, options });
    findOneAndUpdateCalls += 1;
    const doc = findOneAndUpdateCalls === 1 ? stored({ xp: 110, awardedTaskIds: ['older', TASK_ID], activeDays: ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'] }) : stored({ xp: 110, streakDays: 4, lastActiveDate: '2026-10-06', awardedTaskIds: ['older', TASK_ID], activeDays: ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'] });
    // The driver returns the document directly (includeResultMetadata false), or a ModifyResult — answer both ways.
    return options?.includeResultMetadata === true ? { value: doc, ok: 1 } : doc;
  };
  collection.updateOne = record('updateOne', () => ({ matchedCount: 1, modifiedCount: 1 }));
  collection.findOne = record('findOne', () => stored());
});

afterEach(() => vi.restoreAllMocks());

describe('the command Mongoose sends for an award', () => {
  it('step 1 is ONE conditional update: not-yet-awarded + ledger-has-room + usable-xp + history-has-room filter; $inc, $push and the award day together', async () => {
    const result = await awardTaskCompletion(USER_ID, TASK_ID, new Date('2026-10-06T10:00:00.000Z'));
    expect(result.awarded).toBe(true);

    // The award is the first findOneAndUpdate. (Before it, one lean pre-flight read validates the stored history.)
    const award = sent.filter((c) => c.method === 'findOneAndUpdate')[0];
    expect(award.method).toBe('findOneAndUpdate');

    const preflight = sent[0];
    expect(preflight.method).toBe('findOne');
    expect(String(preflight.filter._id)).toBe(USER_ID);
    // (the recording helper stores a findOne's options in its second slot, `update`)
    expect(preflight.update).toEqual({ projection: { 'treeState.activeDays': 1 } }); // the history only, never the whole tree

    // Filter: every guard survived casting, including the array-index path.
    expect(String(award.filter._id)).toBe(USER_ID);
    expect(award.filter['treeState.awardedTaskIds']).toEqual({ $ne: TASK_ID });
    expect(award.filter['treeState.awardedTaskIds.19999']).toEqual({ $exists: false });
    expect(award.filter['treeState.xp']).toEqual({ $gte: 0, $lte: Number.MAX_SAFE_INTEGER - 10 });
    // The retained history must exist as an array, and have room for today unless today is already in it.
    expect(award.filter['treeState.activeDays']).toEqual({ $type: 'array' });
    expect(award.filter.$or).toEqual([{ 'treeState.activeDays': '2026-10-06' }, { 'treeState.activeDays.19999': { $exists: false } }]);

    // Update: XP, ledger and the award day change in the SAME operation; nothing else rides along.
    expect(withoutTimestamps(award.update)).toEqual({
      $inc: { 'treeState.xp': 10 },
      $push: { 'treeState.awardedTaskIds': TASK_ID },
      $addToSet: { 'treeState.activeDays': '2026-10-06' },
    });
    expect(award.options).toMatchObject({ returnDocument: 'after' });
  });

  it('step 2 is a compare-and-set pinned to xp, streakDays and lastActiveDate; it writes the values folded from the retained history', async () => {
    await awardTaskCompletion(USER_ID, TASK_ID, new Date('2026-10-06T10:00:00.000Z'));

    const derived = sent.filter((c) => c.method === 'findOneAndUpdate')[1];
    expect(derived.method).toBe('findOneAndUpdate');
    expect(derived.filter).toMatchObject({
      'treeState.xp': 110,
      'treeState.streakDays': 3,
      'treeState.lastActiveDate': '2026-10-05',
    });
    expect(withoutTimestamps(derived.update)).toEqual({
      $set: {
        'treeState.streakDays': 4,
        'treeState.lastActiveDate': '2026-10-06',
        'treeState.health': 'healthy',
        'treeState.leaves': 5,
        'treeState.stage': 'young',
        'treeState.lastCalculatedAt': '2026-10-06T10:00:00.000Z',
      },
    });
  });

  it('the schema still declares every field the award writes (strict mode would otherwise drop it)', () => {
    for (const path of [
      'treeState.xp',
      'treeState.leaves',
      'treeState.streakDays',
      'treeState.lastActiveDate',
      'treeState.health',
      'treeState.stage',
      'treeState.lastCalculatedAt',
      'treeState.awardedTaskIds',
      'treeState.activeDays',
      'treeState.pendingDerivedDays',
    ]) {
      expect(User.schema.path(path), path).toBeDefined();
    }
  });
});

describe('repairing a forged Infinity xp (the old PATCH allowed `1e999`)', () => {
  it('casts Infinity in the compare-and-set filter instead of throwing, repairs to 0, then awards', async () => {
    const collection = User.collection as unknown as Record<string, unknown>;
    let awardCalls = 0;
    collection.findOneAndUpdate = async (filter: Record<string, unknown>, update: Record<string, unknown>, options: Record<string, unknown>) => {
      sent.push({ method: 'findOneAndUpdate', filter, update, options });
      awardCalls += 1;
      if (awardCalls === 1) return null; // the xp guard ($lte MAX_SAFE) rejects Infinity: nothing matched
      return stored({ xp: 10, awardedTaskIds: [TASK_ID] });
    };
    collection.findOne = async () => stored({ xp: Infinity });

    const result = await awardTaskCompletion(USER_ID, TASK_ID, new Date('2026-10-06T10:00:00.000Z'));

    const repair = sent.find((c) => c.method === 'updateOne');
    expect(repair?.filter['treeState.xp']).toBe(Infinity);
    expect(withoutTimestamps(repair?.update)).toEqual({ $set: { 'treeState.xp': 0 } });
    expect(result.awarded).toBe(true);
    expect(result.treeState.xp).toBe(10);
  });
});

describe('adopting the retained history (a legacy tree has no activeDays)', () => {
  it('is ONE pinned write that sets the implied days and removes the old marker; the award follows', async () => {
    const collection = User.collection as unknown as Record<string, unknown>;
    let call = 0;
    collection.findOneAndUpdate = async (filter: Record<string, unknown>, update: Record<string, unknown>, options: Record<string, unknown>) => {
      sent.push({ method: 'findOneAndUpdate', filter, update, options });
      call += 1;
      if (call === 1) return null; // no activeDays array yet: the award filter matches nothing
      if (call === 2) return stored({ xp: 110, awardedTaskIds: ['older', TASK_ID], activeDays: ['2026-10-04', '2026-10-05', '2026-10-06'] });
      return stored({ xp: 110, streakDays: 3, lastActiveDate: '2026-10-06', awardedTaskIds: ['older', TASK_ID], activeDays: ['2026-10-04', '2026-10-05', '2026-10-06'] });
    };
    // A legacy document: a streak of 2 ending 2026-10-05, a marker day, and no activeDays at all.
    collection.findOne = async () => ({ treeState: { xp: 100, streakDays: 2, lastActiveDate: '2026-10-05', awardedTaskIds: ['older'], pendingDerivedDays: ['2026-10-05'] } });

    const result = await awardTaskCompletion(USER_ID, TASK_ID, new Date('2026-10-06T10:00:00.000Z'));

    const adoption = sent.find((c) => c.method === 'updateOne');
    expect(adoption?.filter).toMatchObject({
      'treeState.activeDays': null,
      'treeState.xp': 100,
      'treeState.streakDays': 2,
      'treeState.lastActiveDate': '2026-10-05',
    });
    expect(withoutTimestamps(adoption?.update)).toEqual({
      $set: { 'treeState.activeDays': ['2026-10-04', '2026-10-05'] },
      $unset: { 'treeState.pendingDerivedDays': '' },
    });
    expect(result).toMatchObject({ awarded: true });
    expect(result.treeState).toMatchObject({ streakDays: 3, lastActiveDate: '2026-10-06' });
  });
});
