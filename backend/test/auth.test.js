const test = require('node:test');
const assert = require('node:assert/strict');

// Force in-memory mode for these unit tests.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_KEY;
process.env.ALLOW_PUBLIC_REGISTRATION = 'true';

const auth = require('../services/auth.service');

test('register then log in with the correct password', async () => {
  const { user, token } = await auth.registerUser({
    fullName: 'Test Attorney',
    email: 'attorney@example.com',
    password: 'CorrectHorse123',
  });
  assert.equal(user.role, 'attorney');
  assert.ok(token);

  const login = await auth.loginUser({
    email: 'attorney@example.com',
    password: 'CorrectHorse123',
  });
  assert.equal(login.user.email, 'attorney@example.com');
});

test('wrong password is rejected with 401', async () => {
  await assert.rejects(
    auth.loginUser({ email: 'attorney@example.com', password: 'WrongHorse123' }),
    (error) => error.statusCode === 401,
  );
});

test('public registration cannot choose its own role', async () => {
  const { user } = await auth.registerUser({
    fullName: 'Sneaky',
    email: 'sneaky@example.com',
    password: 'CorrectHorse123',
    role: 'admin',
  });
  assert.equal(user.role, 'attorney');
});

test('requireRoles blocks non-admins', () => {
  const middleware = auth.requireRoles('admin');
  let received;
  middleware({ auth: { role: 'paralegal' } }, {}, (error) => {
    received = error;
  });
  assert.equal(received.statusCode, 403);
});
