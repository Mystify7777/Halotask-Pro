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
  treeState: { xp: 100, streakDays: 3, lastActiveDate: '2026-10-05', awardedTaskIds: ['older'], ...over },
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
    const doc = findOneAndUpdateCalls === 1 ? stored({ xp: 110, awardedTaskIds: ['older', TASK_ID], pendingDerivedDays: ['2026-10-06'] }) : stored({ xp: 110, streakDays: 4, lastActiveDate: '2026-10-06', awardedTaskIds: ['older', TASK_ID] });
    // The driver returns the document directly (includeResultMetadata false), or a ModifyResult — answer both ways.
    return options?.includeResultMetadata === true ? { value: doc, ok: 1 } : doc;
  };
  collection.updateOne = record('updateOne', () => ({ matchedCount: 1, modifiedCount: 1 }));
  collection.findOne = record('findOne', () => stored());
});

afterEach(() => vi.restoreAllMocks());

describe('the command Mongoose sends for an award', () => {
  it('step 1 is ONE conditional update: not-yet-awarded + ledger-has-room + usable-xp filter; $inc, $push and the recovery marker together', async () => {
    const result = await awardTaskCompletion(USER_ID, TASK_ID, new Date('2026-10-06T10:00:00.000Z'));
    expect(result.awarded).toBe(true);

    const award = sent[0];
    expect(award.method).toBe('findOneAndUpdate');

    // Filter: every guard survived casting, including the array-index path.
    expect(String(award.filter._id)).toBe(USER_ID);
    expect(award.filter['treeState.awardedTaskIds']).toEqual({ $ne: TASK_ID });
    expect(award.filter['treeState.awardedTaskIds.19999']).toEqual({ $exists: false });
    expect(award.filter['treeState.xp']).toEqual({ $gte: 0, $lte: Number.MAX_SAFE_INTEGER - 10 });

    // Update: XP, ledger and the recovery marker change in the SAME operation; nothing else rides along.
    expect(withoutTimestamps(award.update)).toEqual({
      $inc: { 'treeState.xp': 10 },
      $push: { 'treeState.awardedTaskIds': TASK_ID },
      $addToSet: { 'treeState.pendingDerivedDays': '2026-10-06' },
    });
    expect(award.options).toMatchObject({ returnDocument: 'after' });
  });

  it('step 2 is a compare-and-set pinned to xp, streakDays, lastActiveDate and the marker; it writes server-computed values and clears the marker', async () => {
    await awardTaskCompletion(USER_ID, TASK_ID, new Date('2026-10-06T10:00:00.000Z'));

    const derived = sent[1];
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
      $unset: { 'treeState.pendingDerivedDays': '' },
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
