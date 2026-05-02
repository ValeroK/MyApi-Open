'use strict';

/**
 * POST /api/v1/auth/onboarding/dismiss clears users.needs_onboarding
 * (dashboard wizard must not reopen on refresh).
 */

const request = require('supertest');

const emailService = require('../services/emailService');
if (typeof emailService.sendWelcomeEmail !== 'function') {
  emailService.sendWelcomeEmail = async () => undefined;
}
jest.spyOn(emailService, 'sendWelcomeEmail').mockImplementation(async () => undefined);

const { app } = require('../index');
const { setUserNeedsOnboarding, getUserById } = require('../database');

function uniqueUser(tag = 'obd') {
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    username: `${tag}_${Date.now().toString(36).slice(-6)}_${rand}`,
    email: `${tag}_${Date.now().toString(36).slice(-6)}_${rand}@example.com`,
    password: 'Strong!Pass123',
  };
}

describe('POST /api/v1/auth/onboarding/dismiss', () => {
  jest.setTimeout(25_000);

  test('returns 401 without authentication', async () => {
    const res = await request(app).post('/api/v1/auth/onboarding/dismiss').send({});
    expect(res.status).toBe(401);
  });

  test('clears needs_onboarding and GET /auth/me reflects it', async () => {
    const u = uniqueUser();
    const agent = request.agent(app);

    const reg = await agent
      .post('/api/v1/auth/register')
      .send({ username: u.username, email: u.email, password: u.password, display_name: u.username });
    expect(reg.status).toBe(201);

    const me0 = await agent.get('/api/v1/auth/me');
    expect(me0.status).toBe(200);
    const uid =
      me0.body?.user?.id ||
      me0.body?.data?.user?.id ||
      (() => {
        throw new Error('expected user id from /auth/me');
      })();

    setUserNeedsOnboarding(uid, true);
    expect(getUserById(String(uid)).needsOnboarding).toBe(true);

    const meNeeds = await agent.get('/api/v1/auth/me');
    expect(meNeeds.status).toBe(200);
    expect(meNeeds.body?.user?.needsOnboarding).toBe(true);

    const dismiss = await agent.post('/api/v1/auth/onboarding/dismiss').send({});
    expect(dismiss.status).toBe(200);
    expect(dismiss.body?.success).toBe(true);
    expect(dismiss.body?.user?.needsOnboarding).toBe(false);

    const meAfter = await agent.get('/api/v1/auth/me');
    expect(meAfter.status).toBe(200);
    expect(meAfter.body?.user?.needsOnboarding).toBe(false);
    expect(getUserById(String(uid)).needsOnboarding).toBe(false);
  });
});
