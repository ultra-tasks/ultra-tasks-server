import { it } from 'vitest';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { createHarness } from './ultra-account.helper';

// Local, disposable acceptance server. It is never started by the production image.
it('serves synthetic accounts to the provider migration browser tests', async () => {
  const dist = process.env.ULTRA_CLIENT_DIST;
  if (!dist) throw new Error('ULTRA_CLIENT_DIST is required');
  const port = Number(process.env.ULTRA_MIGRATION_PORT ?? 4244);
  const harness = await createHarness({
    privateOnly: true,
    authEngine: 'better-auth',
    disableRateLimit: true,
  });
  try {
    let ready = false;
    harness.app.get('/provider-migration-ready', async (_request, reply) =>
      ready ? { ready: true } : reply.code(503).send({ ready: false }),
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
    ])
      await harness.register(`${username}@example.test`, username);
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
