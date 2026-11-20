import { it } from 'vitest';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { createHarness } from './ultra-account.helper';

// Local, disposable acceptance server. It is never started by the production image.
it('serves synthetic accounts to the provider migration browser tests', async () => {
  const dist = process.env.ULTRA_CLIENT_DIST;
  if (!dist) throw new Error('ULTRA_CLIENT_DIST is required');
  const port = Number(process.env.ULTRA_MIGRATION_PORT ?? 4244);
  const verifyDevice = process.env.ULTRA_MIGRATION_DEVICE_EMAIL === '1';
  const harness = await createHarness({
    privateOnly: true,
    authEngine: 'better-auth',
    deviceEmailVerification: verifyDevice,
    disableRateLimit: true,
  });
  try {
    let ready = false;
    let seededMailCount = 0;
    harness.app.get('/provider-migration-ready', async (_request, reply) =>
      ready ? { ready: true } : reply.code(503).send({ ready: false }),
    );
    if (verifyDevice)
      harness.app.get('/provider-device-verification', async (_request, reply) => {
        const email = harness.mail
          .slice(seededMailCount)
          .findLast(
            (message) =>
              message.kind === 'device' &&
              message.email === 'personaldeviceverify@example.test',
          );
        return email ? { code: email.token } : reply.code(404).send();
      });
    harness.app.put<{ Body: { available: boolean } }>(
      '/provider-database-availability',
      async (request, reply) => {
        const available = request.body?.available;
        if (typeof available !== 'boolean') return reply.code(400).send();
        harness.setDatabaseAvailable(available);
        return { available };
      },
    );
    await harness.app.register(fastifyStatic, { root: resolve(dist) });
    harness.app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Not found' })
        : reply.sendFile('index.html'),
    );
    await harness.app.listen({ host: '127.0.0.1', port });
    harness.config.publicUrl = `http://127.0.0.1:${port}`;
    for (const username of [
      'empty',
      'populated',
      'davlocal',
      'davremote',
      'offline',
      'latepreflight',
      'lateedit',
      'latetab',
      'latemigrate',
      'latemigratetab',
      'latefailure',
      'personaleditarchive',
      'personaleditnote',
      'personaleditoversize',
      'personaledittimer',
      'personaleditold',
      'personaleditrestart',
      'personaleditbatch',
      'personaleditbatchresume',
      'personaltab',
      'personaldeviceverify',
      'sessionoutage',
    ])
      await harness.register(`${username}@example.test`, username);
    seededMailCount = harness.mail.length;
    ready = true;
    process.stdout.write('PROVIDER_MIGRATION_READY\n');
    await new Promise<void>((done) => {
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
  } finally {
    await harness.close();
  }
});
