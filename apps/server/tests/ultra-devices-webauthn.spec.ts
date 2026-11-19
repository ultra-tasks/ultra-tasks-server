import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createHarness, password } from './ultra-account.helper';

// Production-strength Argon2/OPAQUE can exceed the default 5s under parallel suite load.
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });

// No authenticator exists in a route test, so the attestation check is the one thing replaced: it
// accepts the registration and reports a fixed credential. Every other line of the enrolment route,
// including its cleanup of pending email challenges, is the real code.
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'c2VjdXJpdHkta2V5LWZvci1yb3V0ZS10ZXN0cw',
          publicKey: new Uint8Array(65).fill(4),
          counter: 0,
        },
      },
    })),
  };
});

describe('security key enrolment and pending new-device email challenges', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeAll(async () => {
    h = await createHarness({
      privateOnly: true,
      deviceEmailVerification: true,
      disableRateLimit: true,
    });
  });
  afterAll(async () => h.close());

  it('deletes pending email challenges when a security key is enrolled, and the key then takes precedence', async () => {
    const email = 'webauthn@example.test';
    const { client } = await h.register(email, 'webauthnuser');
    const accountId = client.account!.id;
    const pending = async () =>
      Number(
        (
          await h.database.query<{ n: number }>(
            "SELECT count(*) AS n FROM ultra_challenges WHERE kind='device-email' AND account_id=$1",
            [accountId],
          )
        ).rows[0].n,
      );
    await h.client().login(email, password, 'First pending');
    await h.client().login(email, password, 'Second pending');
    expect(await pending()).toBe(2);

    const start = await client.request<{ enrollmentToken: string }>(
      '/factors/webauthn/start',
      {},
    );
    await client.request('/factors/webauthn/finish', {
      enrollmentToken: start.enrollmentToken,
      credential: { id: 'ignored', rawId: 'ignored', type: 'public-key', response: {} },
    });

    expect(await pending()).toBe(0);
    const factors = await h.db.$queryRaw<{ kind: string }[]>(
      Prisma.sql`SELECT kind FROM ultra_factors WHERE account_id=${accountId}`,
    );
    expect(factors.map((row) => row.kind)).toEqual(['webauthn']);
    // With a security key enrolled a password sign-in is answered with the factor step, and the
    // email challenge is never offered in its place.
    expect(await h.legacyLogin(email)).toMatchObject({
      mfaToken: expect.any(String),
      factors: ['webauthn'],
    });
  });
});
