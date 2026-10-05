import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { resetAllRateLimiters } from '../src/middleware/rateLimit';
import '../src/middleware/rateLimiters';
import Task from '../src/models/Task.model';
import User from '../src/models/User.model';
import { TEST_JWT_SECRET } from './testConfig';

const TEST_CLIENT_ORIGIN = 'http://localhost:5173';

let mongoServer: MongoMemoryServer;

type AuthResult = {
  token: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
};

const setTestEnv = () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.CLIENT_ORIGIN = TEST_CLIENT_ORIGIN;
};

const registerUser = async (payload: { name: string; email: string; password: string }) => {
  const response = await request(app).post('/api/auth/register').send(payload);
  return response;
};

const loginUser = async (payload: { email: string; password: string }) => {
  const response = await request(app).post('/api/auth/login').send(payload);
  return response;
};

const createTaskForUser = async (token: string, taskPayload: Record<string, unknown>) => {
  return request(app).post('/api/tasks').set('Authorization', `Bearer ${token}`).send(taskPayload);
};

describe('HaloTasks API routes', () => {
  beforeAll(async () => {
    setTestEnv();
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  beforeEach(async () => {
    setTestEnv();
    // Every request here comes from one address; start each test with fresh rate-limit counters.
    resetAllRateLimiters();
    await User.deleteMany({});
    await Task.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  it('registers a user, returns a token, and hashes the password', async () => {
    const response = await registerUser({
      name: 'User',
      email: 'user@mail.com',
      password: '123456',
    });

    expect(response.status).toBe(201);
    expect(response.body.token).toBeTypeOf('string');

    const decoded = jwt.verify(response.body.token, TEST_JWT_SECRET) as jwt.JwtPayload & {
      userId: string;
      email: string;
      name: string;
    };
    expect(decoded.email).toBe('user@mail.com');
    expect(decoded.name).toBe('User');

    const user = await User.findOne({ email: 'user@mail.com' });
    expect(user).not.toBeNull();
    expect(user?.passwordHash).not.toBe('123456');
    expect(await bcrypt.compare('123456', user!.passwordHash)).toBe(true);
  });

  it('blocks duplicate email registration', async () => {
    await registerUser({ name: 'User', email: 'user@mail.com', password: '123456' });
    const duplicateResponse = await registerUser({ name: 'User 2', email: 'user@mail.com', password: 'abcdef' });

    expect(duplicateResponse.status).toBe(409);
    expect(duplicateResponse.body.message).toContain('already registered');
  });

  it('rejects wrong password and returns a JWT on successful login', async () => {
    await registerUser({ name: 'User', email: 'user@mail.com', password: '123456' });

    const badLoginResponse = await loginUser({ email: 'user@mail.com', password: 'wrong-pass' });
    expect(badLoginResponse.status).toBe(401);

    const goodLoginResponse = await loginUser({ email: 'user@mail.com', password: '123456' });
    expect(goodLoginResponse.status).toBe(200);
    expect(goodLoginResponse.body.token).toBeTypeOf('string');

    const decoded = jwt.verify(goodLoginResponse.body.token, TEST_JWT_SECRET) as jwt.JwtPayload & {
      userId: string;
      email: string;
      name: string;
    };
    expect(decoded.email).toBe('user@mail.com');
  });

  it('denies access to protected task routes without a token', async () => {
    const response = await request(app).get('/api/tasks');

    expect(response.status).toBe(401);
    expect(response.body.message).toContain('Authorization token is required');
  });

  it('creates tasks linked to the logged-in user and only returns that user\'s tasks', async () => {
    const userOne = (await registerUser({ name: 'User One', email: 'one@mail.com', password: '123456' })).body as AuthResult;
    const userTwo = (await registerUser({ name: 'User Two', email: 'two@mail.com', password: '123456' })).body as AuthResult;

    const taskOneResponse = await createTaskForUser(userOne.token, {
      title: 'Study DSA',
      description: 'Solve problems',
      completed: false,
      priority: 'high',
      tags: ['study'],
      dueDate: '2026-04-21',
    });

    const taskTwoResponse = await createTaskForUser(userTwo.token, {
      title: 'Write cover letter',
      priority: 'medium',
      tags: ['job'],
    });

    expect(taskOneResponse.status).toBe(201);
    expect(taskOneResponse.body.task.userId).toBeTypeOf('string');
    expect(taskOneResponse.body.task.title).toBe('Study DSA');
    expect(taskOneResponse.body.task.completed).toBe(false);

    const taskOneId = taskOneResponse.body.task._id as string;

    const storedTask = await Task.findById(taskOneId);
    expect(storedTask?.userId.toString()).toBe(userOne.user.id);

    expect(taskTwoResponse.status).toBe(201);

    const userOneTasks = await request(app).get('/api/tasks').set('Authorization', `Bearer ${userOne.token}`);
    expect(userOneTasks.status).toBe(200);
    expect(userOneTasks.body.tasks).toHaveLength(1);
    expect(userOneTasks.body.tasks[0].title).toBe('Study DSA');

    const userTwoTasks = await request(app).get('/api/tasks').set('Authorization', `Bearer ${userTwo.token}`);
    expect(userTwoTasks.status).toBe(200);
    expect(userTwoTasks.body.tasks).toHaveLength(1);
    expect(userTwoTasks.body.tasks[0].title).toBe('Write cover letter');
  });

  it('only allows task updates and deletes for the owning user', async () => {
    const userOne = (await registerUser({ name: 'User One', email: 'one@mail.com', password: '123456' })).body as AuthResult;
    const userTwo = (await registerUser({ name: 'User Two', email: 'two@mail.com', password: '123456' })).body as AuthResult;

    const ownedTaskResponse = await createTaskForUser(userOne.token, {
      title: 'Own task',
      priority: 'low',
    });
    const foreignTaskResponse = await createTaskForUser(userTwo.token, {
      title: 'Foreign task',
      priority: 'medium',
    });

    const ownedTaskId = ownedTaskResponse.body.task._id as string;
    const foreignTaskId = foreignTaskResponse.body.task._id as string;

    const ownUpdateResponse = await request(app)
      .put(`/api/tasks/${ownedTaskId}`)
      .set('Authorization', `Bearer ${userOne.token}`)
      .send({ completed: true, priority: 'high' });

    expect(ownUpdateResponse.status).toBe(200);
    expect(ownUpdateResponse.body.task.completed).toBe(true);
    expect(ownUpdateResponse.body.task.priority).toBe('high');

    const foreignUpdateResponse = await request(app)
      .put(`/api/tasks/${foreignTaskId}`)
      .set('Authorization', `Bearer ${userOne.token}`)
      .send({ completed: true });

    expect(foreignUpdateResponse.status).toBe(404);
    expect(foreignUpdateResponse.body.message).toBe('Task not found');

    const foreignTaskAfterUpdate = await Task.findById(foreignTaskId);
    expect(foreignTaskAfterUpdate?.completed).toBe(false);

    const ownDeleteResponse = await request(app)
      .delete(`/api/tasks/${ownedTaskId}`)
      .set('Authorization', `Bearer ${userOne.token}`);

    expect(ownDeleteResponse.status).toBe(200);
    expect(ownDeleteResponse.body.message).toBe('Task deleted');

    const foreignDeleteResponse = await request(app)
      .delete(`/api/tasks/${foreignTaskId}`)
      .set('Authorization', `Bearer ${userOne.token}`);

    expect(foreignDeleteResponse.status).toBe(404);
    expect(foreignDeleteResponse.body.message).toBe('Task not found');

    const remainingForeignTask = await Task.findById(foreignTaskId);
    expect(remainingForeignTask).not.toBeNull();
  });

  it('rejects registration with a password shorter than the minimum length', async () => {
    const response = await registerUser({ name: 'Short Pass', email: 'shortpass@mail.com', password: '123' });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('at least');

    const user = await User.findOne({ email: 'shortpass@mail.com' });
    expect(user).toBeNull();
  });

  it('rejects registration with a malformed email address', async () => {
    const response = await registerUser({ name: 'Bad Email', email: 'not-an-email', password: '123456' });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('valid email');
  });

  it('normalizes a name with extra internal whitespace on registration', async () => {
    const response = await registerUser({ name: '  Aryan   K  ', email: 'aryan@mail.com', password: '123456' });

    expect(response.status).toBe(201);
    expect(response.body.user.name).toBe('Aryan K');

    const user = await User.findOne({ email: 'aryan@mail.com' });
    expect(user?.name).toBe('Aryan K');
  });

  it('rejects registration with a name that is empty after trimming', async () => {
    const response = await registerUser({ name: '   ', email: 'blankname@mail.com', password: '123456' });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('name');
  });

  it('completes the forgot-password -> reset-password round trip using the demo-mode logged code', async () => {
    await registerUser({ name: 'Reset User', email: 'reset@mail.com', password: 'old-password' });

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const forgotResponse = await request(app).post('/api/auth/forgot-password').send({ email: 'reset@mail.com' });
    expect(forgotResponse.status).toBe(200);
    expect(forgotResponse.body.message).toContain('a reset link has been sent');

    const demoLogCall = infoSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('DEMO MODE'),
    );
    expect(demoLogCall).toBeDefined();

    const match = /code for .*?: (\d{6})/.exec(demoLogCall?.[0] as string);
    expect(match).not.toBeNull();
    const resetCode = match![1];
    infoSpy.mockRestore();

    const wrongCodeResponse = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'reset@mail.com', token: '000000', password: 'new-password' });
    expect(wrongCodeResponse.status).toBe(400);

    const shortPasswordResponse = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'reset@mail.com', token: resetCode, password: '123' });
    expect(shortPasswordResponse.status).toBe(400);

    const goodResetResponse = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'reset@mail.com', token: resetCode, password: 'new-password' });
    expect(goodResetResponse.status).toBe(200);

    const loginWithNewPassword = await loginUser({ email: 'reset@mail.com', password: 'new-password' });
    expect(loginWithNewPassword.status).toBe(200);

    const loginWithOldPassword = await loginUser({ email: 'reset@mail.com', password: 'old-password' });
    expect(loginWithOldPassword.status).toBe(401);

    // The code is single-use — reusing it after a successful reset must fail.
    const reuseResponse = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'reset@mail.com', token: resetCode, password: 'another-password' });
    expect(reuseResponse.status).toBe(400);
  });

  describe('session invalidation after a password reset (Issue #27), against a real MongoDB', () => {
    const RESET_CODE = '246810';

    const seedResetCode = async (email: string) => {
      await User.updateOne(
        { email },
        {
          resetPasswordTokenHash: crypto.createHash('sha256').update(RESET_CODE).digest('hex'),
          resetPasswordExpiresAt: new Date(Date.now() + 20 * 60 * 1000),
        },
      );
    };

    const resetWith = (email: string, password: string, code = RESET_CODE) =>
      request(app).post('/api/auth/reset-password').send({ email, token: code, password });

    const probe = (token: string) => request(app).get('/api/tasks').set('Authorization', `Bearer ${token}`);

    it('revokes every session issued before the reset, clears push subscriptions, and honours a fresh login', async () => {
      const registered = await registerUser({ name: 'Victim', email: 'victim@mail.com', password: 'old-password' });
      const oldToken: string = registered.body.token;
      expect((jwt.decode(oldToken) as { tv?: number }).tv).toBe(0);
      expect((await probe(oldToken)).status).toBe(200);

      await User.updateOne(
        { email: 'victim@mail.com' },
        { $push: { pushSubscriptions: { endpoint: 'https://push.example.com/a', keys: { p256dh: 'p', auth: 'a' } } } },
      );
      await seedResetCode('victim@mail.com');

      expect((await resetWith('victim@mail.com', 'new-password')).status).toBe(200);

      const stored = await User.findOne({ email: 'victim@mail.com' });
      expect(stored?.tokenVersion).toBe(1);
      expect(stored?.pushSubscriptions).toHaveLength(0);
      expect(stored?.resetPasswordTokenHash).toBeUndefined();

      const stale = await probe(oldToken);
      expect(stale.status).toBe(401);
      expect(stale.body).toEqual({ message: 'Invalid or expired token' });

      const fresh = await loginUser({ email: 'victim@mail.com', password: 'new-password' });
      expect(fresh.status).toBe(200);
      expect((jwt.decode(fresh.body.token) as { tv?: number }).tv).toBe(1);
      expect((await probe(fresh.body.token)).status).toBe(200);
    });

    it('keeps the reset code single-use, including when two requests race with it', async () => {
      await registerUser({ name: 'Race', email: 'race@mail.com', password: 'old-password' });
      await seedResetCode('race@mail.com');

      const [one, two] = await Promise.all([
        resetWith('race@mail.com', 'password-from-one'),
        resetWith('race@mail.com', 'password-from-two'),
      ]);

      expect([one.status, two.status].sort()).toEqual([200, 400]);
      expect((await User.findOne({ email: 'race@mail.com' }))?.tokenVersion).toBe(1);

      const replay = await resetWith('race@mail.com', 'attacker-password');
      expect(replay.status).toBe(400);
      expect((await User.findOne({ email: 'race@mail.com' }))?.tokenVersion).toBe(1);
    });

    it('treats an account that predates tokenVersion as version 0, and revokes its old tokens on reset', async () => {
      const registered = await registerUser({ name: 'Legacy', email: 'legacy@mail.com', password: 'old-password' });
      await User.updateOne({ email: 'legacy@mail.com' }, { $unset: { tokenVersion: 1 } });
      const user = await User.findOne({ email: 'legacy@mail.com' });
      const legacyToken = jwt.sign(
        { userId: user!.id, email: user!.email, name: user!.name },
        TEST_JWT_SECRET,
      );

      expect((await probe(legacyToken)).status).toBe(200);
      expect((await probe(registered.body.token)).status).toBe(200);

      await seedResetCode('legacy@mail.com');
      expect((await resetWith('legacy@mail.com', 'new-password')).status).toBe(200);

      expect((await probe(legacyToken)).status).toBe(401);
      expect((await probe(registered.body.token)).status).toBe(401);
    });

    it('rejects a token for an account that no longer exists', async () => {
      const registered = await registerUser({ name: 'Gone', email: 'gone@mail.com', password: 'old-password' });
      expect((await probe(registered.body.token)).status).toBe(200);

      await User.deleteOne({ email: 'gone@mail.com' });

      expect((await probe(registered.body.token)).status).toBe(401);
    });
  });

  it('returns the same neutral message for forgot-password whether or not the account exists', async () => {
    await registerUser({ name: 'Exists', email: 'exists@mail.com', password: '123456' });

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const knownResponse = await request(app).post('/api/auth/forgot-password').send({ email: 'exists@mail.com' });
    const unknownResponse = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nobody@mail.com' });
    infoSpy.mockRestore();

    expect(knownResponse.status).toBe(200);
    expect(unknownResponse.status).toBe(200);
    expect(knownResponse.body.message).toBe(unknownResponse.body.message);
  });

  describe('task API validation and query boundaries', () => {
    it('returns a 400 (not a 500) for a malformed task id on update and delete', async () => {
      const user = (await registerUser({ name: 'Boundary User', email: 'boundary@mail.com', password: '123456' }))
        .body as AuthResult;

      const updateResponse = await request(app)
        .put('/api/tasks/not-a-valid-object-id')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ title: 'New title' });
      expect(updateResponse.status).toBe(400);
      expect(updateResponse.body.message).toContain('Invalid task id');

      const deleteResponse = await request(app)
        .delete('/api/tasks/also-not-valid')
        .set('Authorization', `Bearer ${user.token}`);
      expect(deleteResponse.status).toBe(400);
      expect(deleteResponse.body.message).toContain('Invalid task id');
    });

    it('returns 404 (not 400) for a well-formed but non-existent task id', async () => {
      const user = (await registerUser({ name: 'Ghost User', email: 'ghost@mail.com', password: '123456' }))
        .body as AuthResult;
      const wellFormedButMissingId = new mongoose.Types.ObjectId().toHexString();

      const response = await request(app)
        .put(`/api/tasks/${wellFormedButMissingId}`)
        .set('Authorization', `Bearer ${user.token}`)
        .send({ title: 'Ghost task' });

      expect(response.status).toBe(404);
    });

    it('rejects an invalid due date on create rather than persisting an Invalid Date', async () => {
      const user = (await registerUser({ name: 'Date User', email: 'dateuser@mail.com', password: '123456' }))
        .body as AuthResult;

      const response = await createTaskForUser(user.token, { title: 'Bad date task', dueDate: 'not-a-real-date' });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('dueDate');

      const stored = await Task.findOne({ title: 'Bad date task' });
      expect(stored).toBeNull();
    });

    it('rejects an invalid due date on update', async () => {
      const user = (await registerUser({ name: 'Date User 2', email: 'dateuser2@mail.com', password: '123456' }))
        .body as AuthResult;
      const created = await createTaskForUser(user.token, { title: 'Valid task' });
      const taskId = created.body.task._id as string;

      const response = await request(app)
        .put(`/api/tasks/${taskId}`)
        .set('Authorization', `Bearer ${user.token}`)
        .send({ dueDate: 'also-not-a-date' });

      expect(response.status).toBe(400);

      const stored = await Task.findById(taskId);
      expect(stored?.dueDate).toBeUndefined();
    });

    it('rejects empty or whitespace-only titles consistently on both create and update', async () => {
      const user = (await registerUser({ name: 'Title User', email: 'titleuser@mail.com', password: '123456' }))
        .body as AuthResult;

      const createResponse = await createTaskForUser(user.token, { title: '   ' });
      expect(createResponse.status).toBe(400);

      const created = await createTaskForUser(user.token, { title: 'Real task' });
      const taskId = created.body.task._id as string;

      const updateResponse = await request(app)
        .put(`/api/tasks/${taskId}`)
        .set('Authorization', `Bearer ${user.token}`)
        .send({ title: '   ' });

      expect(updateResponse.status).toBe(400);

      // Confirm the title in the DB was never silently blanked out.
      const stored = await Task.findById(taskId);
      expect(stored?.title).toBe('Real task');
    });

    it('rejects a title over the maximum length instead of silently truncating it', async () => {
      const user = (await registerUser({ name: 'Long Title', email: 'longtitle@mail.com', password: '123456' }))
        .body as AuthResult;

      const response = await createTaskForUser(user.token, { title: 'a'.repeat(500) });

      expect(response.status).toBe(400);
      const stored = await Task.findOne({ userId: new mongoose.Types.ObjectId(user.user.id) });
      expect(stored).toBeNull();
    });

    it('rejects an invalid priority value', async () => {
      const user = (await registerUser({ name: 'Priority User', email: 'priorityuser@mail.com', password: '123456' }))
        .body as AuthResult;

      const response = await createTaskForUser(user.token, { title: 'Task', priority: 'urgent' });
      expect(response.status).toBe(400);
    });

    it('rejects too many tags and an over-length tag', async () => {
      const user = (await registerUser({ name: 'Tag User', email: 'taguser@mail.com', password: '123456' }))
        .body as AuthResult;

      const tooManyTags = await createTaskForUser(user.token, {
        title: 'Task',
        tags: Array.from({ length: 25 }, (_, i) => `tag${i}`),
      });
      expect(tooManyTags.status).toBe(400);

      const overLengthTag = await createTaskForUser(user.token, { title: 'Task', tags: ['a'.repeat(100)] });
      expect(overLengthTag.status).toBe(400);
    });

    it('rejects a negative or absurdly large estimatedMinutes', async () => {
      const user = (await registerUser({ name: 'Minutes User', email: 'minutesuser@mail.com', password: '123456' }))
        .body as AuthResult;

      const negative = await createTaskForUser(user.token, { title: 'Task', estimatedMinutes: -5 });
      expect(negative.status).toBe(400);

      const tooLarge = await createTaskForUser(user.token, { title: 'Task', estimatedMinutes: 999_999_999 });
      expect(tooLarge.status).toBe(400);
    });

    it('rejects an empty string for estimatedMinutes rather than silently coercing it to zero', async () => {
      const user = (
        await registerUser({ name: 'Empty Minutes User', email: 'emptyminutes@mail.com', password: '123456' })
      ).body as AuthResult;

      const response = await createTaskForUser(user.token, { title: 'Task', estimatedMinutes: '' });
      expect(response.status).toBe(400);

      const stored = await Task.findOne({ title: 'Task', userId: new mongoose.Types.ObjectId(user.user.id) });
      expect(stored).toBeNull();
    });

    it('paginates task listing with a default and a bounded maximum page size', async () => {
      const user = (await registerUser({ name: 'Page User', email: 'pageuser@mail.com', password: '123456' }))
        .body as AuthResult;

      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await createTaskForUser(user.token, { title: `Task ${i}` });
      }

      const firstPage = await request(app)
        .get('/api/tasks?page=1&limit=2')
        .set('Authorization', `Bearer ${user.token}`);

      expect(firstPage.status).toBe(200);
      expect(firstPage.body.tasks).toHaveLength(2);
      expect(firstPage.body.page).toBe(1);
      expect(firstPage.body.limit).toBe(2);
      expect(firstPage.body.total).toBe(5);
      expect(firstPage.body.hasMore).toBe(true);

      const secondPage = await request(app)
        .get('/api/tasks?page=2&limit=2')
        .set('Authorization', `Bearer ${user.token}`);
      expect(secondPage.body.tasks).toHaveLength(2);

      const lastPage = await request(app)
        .get('/api/tasks?page=3&limit=2')
        .set('Authorization', `Bearer ${user.token}`);
      expect(lastPage.body.tasks).toHaveLength(1);
      expect(lastPage.body.hasMore).toBe(false);

      // No page/limit at all — the pre-pagination contract — still returns
      // every task the user has (well under the default page size).
      const unpaginated = await request(app).get('/api/tasks').set('Authorization', `Bearer ${user.token}`);
      expect(unpaginated.body.tasks).toHaveLength(5);
    });

    it('caps an oversized limit request rather than rejecting it', async () => {
      const user = (await registerUser({ name: 'Cap User', email: 'capuser@mail.com', password: '123456' }))
        .body as AuthResult;
      await createTaskForUser(user.token, { title: 'Only task' });

      const response = await request(app)
        .get('/api/tasks?limit=999999')
        .set('Authorization', `Bearer ${user.token}`);

      expect(response.status).toBe(200);
      expect(response.body.limit).toBeLessThanOrEqual(200);
    });

    it('rejects a malformed pagination query deliberately instead of silently defaulting', async () => {
      const user = (await registerUser({ name: 'Bad Page User', email: 'badpageuser@mail.com', password: '123456' }))
        .body as AuthResult;

      const badPage = await request(app).get('/api/tasks?page=abc').set('Authorization', `Bearer ${user.token}`);
      expect(badPage.status).toBe(400);

      const badLimit = await request(app).get('/api/tasks?limit=-1').set('Authorization', `Bearer ${user.token}`);
      expect(badLimit.status).toBe(400);
    });

    it('pagination never bypasses ownership filtering', async () => {
      const userOne = (await registerUser({ name: 'Owner One', email: 'ownerone@mail.com', password: '123456' }))
        .body as AuthResult;
      const userTwo = (await registerUser({ name: 'Owner Two', email: 'ownertwo@mail.com', password: '123456' }))
        .body as AuthResult;

      await createTaskForUser(userOne.token, { title: 'User one task' });
      await createTaskForUser(userTwo.token, { title: 'User two task A' });
      await createTaskForUser(userTwo.token, { title: 'User two task B' });

      const userOneList = await request(app)
        .get('/api/tasks?page=1&limit=50')
        .set('Authorization', `Bearer ${userOne.token}`);

      expect(userOneList.body.tasks).toHaveLength(1);
      expect(userOneList.body.total).toBe(1);
      expect(userOneList.body.tasks[0].title).toBe('User one task');
    });

    it('still allows a normal, valid task update to go through unchanged', async () => {
      const user = (await registerUser({ name: 'Valid Update', email: 'validupdate@mail.com', password: '123456' }))
        .body as AuthResult;
      const created = await createTaskForUser(user.token, { title: 'Original title', priority: 'low' });
      const taskId = created.body.task._id as string;

      const response = await request(app)
        .put(`/api/tasks/${taskId}`)
        .set('Authorization', `Bearer ${user.token}`)
        .send({ title: 'Updated title', priority: 'high', dueDate: '2026-12-01T00:00:00.000Z' });

      expect(response.status).toBe(200);
      expect(response.body.task.title).toBe('Updated title');
      expect(response.body.task.priority).toBe('high');
    });
  });
});