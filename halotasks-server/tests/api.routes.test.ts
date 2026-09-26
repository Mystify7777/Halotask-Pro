import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import Task from '../src/models/Task.model';
import User from '../src/models/User.model';

const TEST_JWT_SECRET = 'test-jwt-secret-1234567890';
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
});