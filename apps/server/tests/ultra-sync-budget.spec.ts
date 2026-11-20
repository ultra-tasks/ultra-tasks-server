import { describe, expect, it } from 'vitest';
import { createHarness, password } from './ultra-account.helper';

const scopes = '/api/v2/accounts/sync/scopes';
const transactions = `${scopes}/11111111-1111-4111-8111-111111111111/transactions`;
const ticket = '/api/v2/accounts/sync/socket-ticket';
const authorized = (token: string) => ({ authorization: `Bearer ${token}` });

describe('native sync request budgets', () => {
  it('separates clients arriving through a configured trusted proxy', async () => {
    const proxy = '192.0.2.15';
    const h = await createHarness({
      trustProxy: [proxy],
      syncRequestLimits: { ipPerMinute: 1, accountPerMinute: 5 },
    });
    try {
      const { client } = await h.register();
      const throughProxy = (clientAddress: string) =>
        h.app.inject({
          url: scopes,
          remoteAddress: proxy,
          headers: {
            ...authorized(client.tokens!.accessToken),
            'x-forwarded-for': clientAddress,
          },
        });

      expect((await throughProxy('198.51.100.1')).statusCode).toBe(200);
      expect((await throughProxy('198.51.100.1')).statusCode).toBe(429);
      expect((await throughProxy('198.51.100.2')).statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });
  it('charges one peer budget across sync routes and rejects an excess body before parsing', async () => {
    let parsedWrites = 0;
    const h = await createHarness({
      syncRequestLimits: { ipPerMinute: 2, accountPerMinute: 9 },
      beforeRoutes(app) {
        app.addHook('preParsing', async (request, _reply, payload) => {
          if (request.url === transactions) parsedWrites++;
          return payload;
        });
      },
    });
    try {
      const { client } = await h.register();
      const headers = authorized(client.tokens!.accessToken);
      const write = () =>
        h.app.inject({ method: 'POST', url: transactions, headers, payload: {} });

      expect((await write()).statusCode).toBe(404);
      expect((await h.app.inject({ url: scopes, headers })).statusCode).toBe(200);
      const limited = await write();
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.json()).toMatchObject({ code: 'SYNC_RATE_LIMITED' });
      expect(parsedWrites).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('charges one verified account budget across sessions, connections, and ticket requests', async () => {
    const h = await createHarness({
      syncRequestLimits: { ipPerMinute: 9, accountPerMinute: 2 },
    });
    try {
      const { client: first } = await h.register();
      const second = h.client();
      await second.login('alice@example.test', password);
      const { client: anotherMember } = await h.register('bob@example.test', 'bob');
      const firstHeaders = authorized(first.tokens!.accessToken);
      const secondHeaders = authorized(second.tokens!.accessToken);
      expect(first.tokens!.accessToken).not.toBe(second.tokens!.accessToken);

      expect(
        (
          await h.app.inject({
            url: scopes,
            headers: firstHeaders,
            remoteAddress: '192.0.2.1',
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await h.app.inject({
            url: scopes,
            headers: secondHeaders,
            remoteAddress: '192.0.2.2',
          })
        ).statusCode,
      ).toBe(200);
      const limited = await h.app.inject({
        method: 'POST',
        url: ticket,
        headers: secondHeaders,
        remoteAddress: '192.0.2.2',
        payload: { scopes: ['11111111-1111-4111-8111-111111111111'] },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(
        (
          await h.app.inject({
            url: scopes,
            headers: authorized(anotherMember.tokens!.accessToken),
            remoteAddress: '192.0.2.2',
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await h.app.inject({ url: '/api/v2/accounts/me', headers: firstHeaders }))
          .statusCode,
      ).toBe(200);
    } finally {
      await h.close();
    }
  }, 30_000);
});
