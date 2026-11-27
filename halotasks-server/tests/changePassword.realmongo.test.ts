import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { resetAllRateLimiters } from '../src/middleware/rateLimit';
import User from '../src/models/User.model';
import { TEST_JWT_SECRET } from './testConfig';

// Issue #46 — what only a REAL MongoDB can show about PUT /api/user/password:
//   1. the compare-and-set (filter on the hash that was verified) really matches once: of several concurrent changes from the
//      same state exactly one applies, one tokenVersion bump, the others are 409;
//   2. a reset that races a change cannot both win;
//   3. the single update really sets the hash, bumps tokenVersion (creating it on a legacy account), clears the reset code and
//      empties the push subscriptions, and the token in the answer is accepted by requireAuth while the old one is refused.
// tests/changePassword.routes.test.ts covers the route's behaviour against a double; this file is the equality/concurrency gate.
// Needs a MongoDB binary, like the other *.realmongo tests; it is not skipped when one is unavailable.

const OLD = 'old-password-123';
let mongoServer: MongoMemoryServer;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

const makeUser = async (extra: Record<string, unknown> = {}) => {
  const email = `u${new mongoose.Types.ObjectId().toHexString().slice(-8)}@x.test`;
  const user = await User.create({ name: 'U', email, passwordHash: await bcrypt.hash(OLD, 4), ...extra });
  const token = jwt.sign({ userId: user.id, email, name: 'U', tv: user.tokenVersion ?? 0 }, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  return { id: user.id as string, email, token };
};
const change = (token: string, currentPassword: string, newPassword: string) =>
  request(app).put('/api/user/password').set('Authorization', `Bearer ${token}`).send({ currentPassword, newPassword });
const stored = async (id: string) => (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(id) })) as unknown as Record<string, any>;

beforeAll(async () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await User.init();
});
beforeEach(async () => {
  resetAllRateLimiters();
  await User.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('the write', () => {
  it('sets the hash, bumps tokenVersion, clears the reset code, empties the subscriptions; the new token works and the old one does not', async () => {
    const { id, token } = await makeUser({
      resetPasswordTokenHash: sha256('123456'),
      resetPasswordExpiresAt: new Date(Date.now() + 600_000),
      pushSubscriptions: [{ endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }],
    });
    const res = await change(token, OLD, 'brand-new-pass-1');
    expect(res.status).toBe(200);

    const doc = await stored(id);
    expect(await bcrypt.compare('brand-new-pass-1', doc.passwordHash)).toBe(true);
    expect(doc.tokenVersion).toBe(1);
    expect(doc.resetPasswordTokenHash).toBeUndefined();
    expect(doc.resetPasswordExpiresAt).toBeUndefined();
    expect(doc.pushSubscriptions).toEqual([]);

    // old token refused, the returned one accepted
    expect((await change(token, 'brand-new-pass-1', 'brand-new-pass-2')).status).toBe(401);
    expect((await change(res.body.token, 'brand-new-pass-1', 'brand-new-pass-2')).status).toBe(200);
  });

  it('a legacy account with no tokenVersion field gets it created by the $inc (absent -> 1)', async () => {
    const { id, token } = await makeUser();
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $unset: { tokenVersion: '' } });
    expect((await stored(id)).tokenVersion).toBeUndefined();
    const res = await change(token, OLD, 'brand-new-pass-1');
    expect(res.status).toBe(200);
    expect((await stored(id)).tokenVersion).toBe(1);
    expect(jwt.verify(res.body.token, TEST_JWT_SECRET)).toMatchObject({ tv: 1 });
  });

  it('a non-zero tokenVersion is matched exactly by the real filter, and bumped by one', async () => {
    const { id, token } = await makeUser();
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { tokenVersion: 4 } });
    const fresh = jwt.sign({ userId: id, email: 'x@x.test', name: 'U', tv: 4 }, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    void token;
    const res = await change(fresh, OLD, 'brand-new-pass-1');
    expect(res.status).toBe(200);
    expect((await stored(id)).tokenVersion).toBe(5);
    expect(jwt.verify(res.body.token, TEST_JWT_SECRET)).toMatchObject({ tv: 5 });
  });

  it('a wrong current password writes nothing', async () => {
    const { id, token } = await makeUser();
    const before = await stored(id);
    const res = await change(token, 'definitely-wrong', 'brand-new-pass-1');
    expect(res.status).toBe(403);
    expect(await stored(id)).toEqual(before);
  });
});

describe('concurrency', () => {
  it('of 5 simultaneous changes from the same state exactly one applies, with one tokenVersion bump', async () => {
    const { id, token } = await makeUser();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => change(token, OLD, `concurrent-new-${i}-pass`)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409 || s === 401)).toHaveLength(4); // 409 from the write, or 401 once the bump is visible to requireAuth
    expect((await stored(id)).tokenVersion).toBe(1);
    const winner = results.find((r) => r.status === 200)!;
    const index = results.indexOf(winner);
    expect(await bcrypt.compare(`concurrent-new-${index}-pass`, (await stored(id)).passwordHash)).toBe(true);
  });

  it('a reset and a change racing from the same state: one wins, the account ends with exactly one new password and one bump', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { id, email, token } = await makeUser({ resetPasswordTokenHash: sha256('654321'), resetPasswordExpiresAt: new Date(Date.now() + 600_000) });
      const [reset, changed] = await Promise.all([
        request(app).post('/api/auth/reset-password').send({ email, token: '654321', password: 'from-the-reset-1' }),
        change(token, OLD, 'from-the-change-1'),
      ]);
      const doc = await stored(id);
      const resetWon = await bcrypt.compare('from-the-reset-1', doc.passwordHash);
      const changeWon = await bcrypt.compare('from-the-change-1', doc.passwordHash);
      expect(resetWon !== changeWon).toBe(true); // exactly one password is in place
      expect(doc.resetPasswordTokenHash).toBeUndefined(); // either way the code is gone
      if (resetWon) expect(reset.status).toBe(200);
      if (changeWon) expect(changed.status).toBe(200);
      expect(doc.tokenVersion).toBe(1); // the loser writes nothing: a change after the reset fails its CAS or its token check, a reset after the change finds no code
    }
  });
});
