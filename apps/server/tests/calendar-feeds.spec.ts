import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHarness } from './ultra-account.helper';

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
const body =
  'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:one@test\r\nSUMMARY:Busy\r\nDTSTART;VALUE=DATE:20261115\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
interface Feed {
  id: string;
  url: string;
  revision: number;
  generation: number;
}
describe('Calendar publications through real account routes and PostgreSQL', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    vi.stubEnv('ULTRA_CALENDAR_FEEDS_ENABLED', 'true');
    h = await createHarness();
  });
  afterEach(async () => {
    await h?.close();
    vi.unstubAllEnvs();
  });
  it('publishes, conditionally fetches, updates, rotates and revokes a feed', async () => {
    const { client } = await h.register();
    const feed = await client.request<Feed>('/calendar-feeds', {
      label: 'Work',
      body,
      consent: true,
    });
    const path = new URL(feed.url).pathname;
    const response = await h.app.inject({ method: 'GET', url: path });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(body);
    expect(response.headers['content-type']).toContain('text/calendar');
    expect(response.headers['x-robots-tag']).toContain('noindex');
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: path,
          headers: { 'if-none-match': response.headers.etag! },
        })
      ).statusCode,
    ).toBe(304);
    const updated = await client.request<Feed>(
      `/calendar-feeds/${feed.id}`,
      { body: body.replace('Busy', 'Updated'), revision: 1, generation: 1 },
      'PUT',
    );
    expect(updated.revision).toBe(1);
    await expect(
      client.request(
        `/calendar-feeds/${feed.id}`,
        { body, revision: 1, generation: 1 },
        'PUT',
      ),
    ).rejects.toMatchObject({ status: 409 });
    const rotated = await client.request<Feed>(`/calendar-feeds/${feed.id}/rotate`, {});
    expect(rotated.generation).toBe(2);
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: path,
          headers: { 'if-none-match': response.headers.etag! },
        })
      ).statusCode,
    ).toBe(404);
    await expect(
      client.request(
        `/calendar-feeds/${feed.id}`,
        { body, revision: 2, generation: 1 },
        'PUT',
      ),
    ).rejects.toThrow();
    const newPath = new URL(rotated.url).pathname;
    expect((await h.app.inject({ method: 'GET', url: newPath })).body).toContain(
      'Updated',
    );
    await client.request(`/calendar-feeds/${feed.id}`, undefined, 'DELETE');
    expect((await h.app.inject({ method: 'GET', url: newPath })).statusCode).toBe(404);
  });
  it('requires consent and authentication and isolates accounts; deleting an account removes its feed', async () => {
    const { client } = await h.register();
    const other = (await h.register('other@example.test', 'other')).client;
    await expect(
      client.request('/calendar-feeds', { label: 'No consent', body }),
    ).rejects.toThrow();
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v2/accounts/calendar-feeds',
          payload: { label: 'No auth', body, consent: true },
        })
      ).statusCode,
    ).toBe(401);
    const feed = await client.request<Feed>('/calendar-feeds', {
      label: 'Work',
      body,
      consent: true,
    });
    expect(await other.request('/calendar-feeds')).toEqual({ feeds: [] });
    await expect(
      other.request(`/calendar-feeds/${feed.id}/rotate`, {}),
    ).rejects.toThrow();
    await expect(
      other.request(
        `/calendar-feeds/${feed.id}`,
        { body, revision: 1, generation: 1 },
        'PUT',
      ),
    ).rejects.toThrow();
    await other.request(`/calendar-feeds/${feed.id}`, undefined, 'DELETE');
    expect(
      (await h.app.inject({ method: 'GET', url: new URL(feed.url).pathname })).statusCode,
    ).toBe(200);
    const stored = await h.database.query<{ token_hash: string }>(
      'SELECT token_hash FROM ultra_calendar_feeds',
    );
    expect(stored.rows[0].token_hash).not.toContain(
      new URL(feed.url).pathname.split('/')[2].replace('.ics', ''),
    );
    await client.deleteAccount();
    expect(
      (await h.app.inject({ method: 'GET', url: new URL(feed.url).pathname })).statusCode,
    ).toBe(404);
  });
  it('rejects oversized bodies and private note properties, and bounds the number of feeds', async () => {
    const { client } = await h.register();
    await expect(
      client.request('/calendar-feeds', {
        label: 'Private',
        body: body.replace('SUMMARY:Busy', 'DESCRIPTION:Private notes'),
        consent: true,
      }),
    ).rejects.toThrow();
    await expect(
      client.request('/calendar-feeds', {
        label: 'Huge',
        body: 'x'.repeat(1048577),
        consent: true,
      }),
    ).rejects.toThrow();
    for (let i = 0; i < 10; i++)
      await client.request('/calendar-feeds', { label: 'Work', body, consent: true });
    await expect(
      client.request('/calendar-feeds', { label: 'Extra', body, consent: true }),
    ).rejects.toThrow();
  });
});
