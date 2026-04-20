// Smoke Test Script for HaloTaskPro
// Tests all critical API endpoints

const http = require('http');

const API_BASE = 'http://localhost:5000';
let authToken = '';
let testUserId = `test_${Date.now()}`;
let testTaskId = '';

const request = (method, path, data = null) => {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (authToken) {
      options.headers['Authorization'] = `Bearer ${authToken}`;
    }

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, data: json, headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, data: body, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
};

const tests = [];

const test = (name, fn) => {
  tests.push({ name, fn });
};

// ========== AUTH TESTS ==========
test('✓ Register User', async () => {
  const res = await request('POST', '/api/auth/register', {
    email: `${testUserId}@test.com`,
    password: 'Test@123456',
    name: 'Test User',
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`Expected 201/200, got ${res.status}: ${JSON.stringify(res.data)}`);
  console.log('  Email:', res.data.user?.email);
});

test('✓ Login User', async () => {
  const res = await request('POST', '/api/auth/login', {
    email: `${testUserId}@test.com`,
    password: 'Test@123456',
  });
  if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
  if (!res.data.token) throw new Error('No token returned');
  authToken = res.data.token;
  console.log('  Token obtained:', authToken.substring(0, 20) + '...');
});

// ========== TASK TESTS ==========
test('✓ Create Task', async () => {
  const res = await request('POST', '/api/tasks', {
    title: 'Test Task',
    description: 'Smoke test task',
    priority: 'high',
    dueDate: new Date(Date.now() + 24*60*60*1000).toISOString(),
    estimatedMinutes: 30,
    tags: ['test', 'smoke'],
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`Expected 201/200, got ${res.status}: ${JSON.stringify(res.data)}`);
  testTaskId = res.data.task?._id || res.data.task?.id;
  console.log('  Task ID:', testTaskId);
});

test('✓ Get Tasks', async () => {
  const res = await request('GET', '/api/tasks');
  if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
  const tasks = Array.isArray(res.data) ? res.data : res.data.tasks || [];
  if (!Array.isArray(tasks)) throw new Error('Expected array response');
  console.log('  Tasks count:', tasks.length);
});

test('✓ Update Task (Toggle Complete)', async () => {
  const res = await request('PUT', `/api/tasks/${testTaskId}`, {
    completed: true,
  });
  if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
  console.log('  Task updated, completed:', res.data.completed);
});

test('✓ Update Task (Edit Details)', async () => {
  const res = await request('PUT', `/api/tasks/${testTaskId}`, {
    title: 'Updated Test Task',
    priority: 'medium',
    tags: ['updated', 'test'],
  });
  if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
  console.log('  Title updated:', res.data.title);
});

test('✓ Create Multiple Tasks (for bulk)', async () => {
  for (let i = 0; i < 3; i++) {
    const res = await request('POST', '/api/tasks', {
      title: `Bulk Test Task ${i + 1}`,
      priority: i % 2 === 0 ? 'high' : 'low',
      tags: ['bulk-test'],
    });
    if (res.status !== 201 && res.status !== 200) throw new Error(`Expected 201/200, got ${res.status}`);
  }
  console.log('  Created 3 tasks for bulk testing');
});

test('✓ Delete Task', async () => {
  const res = await request('DELETE', `/api/tasks/${testTaskId}`);
  if (res.status !== 200 && res.status !== 204) throw new Error(`Expected 200/204, got ${res.status}: ${JSON.stringify(res.data)}`);
  console.log('  Task deleted successfully');
});

// ========== RUN ALL TESTS ==========
const runTests = async () => {
  console.log('\n' + '='.repeat(60));
  console.log('HALOTASKPRO SMOKE TEST SUITE');
  console.log('='.repeat(60) + '\n');

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    try {
      process.stdout.write(`[${i + 1}/${tests.length}] ${test.name}... `);
      await test.fn();
      console.log('PASS\n');
    } catch (error) {
      console.log(`FAIL\n  Error: ${error.message}\n`);
    }
  }

  console.log('='.repeat(60));
  console.log('Smoke test complete! Now test the UI manually.');
  console.log('='.repeat(60) + '\n');
};

// Wait a moment for servers to be ready, then run
setTimeout(runTests, 1000);
