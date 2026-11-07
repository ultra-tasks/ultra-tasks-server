const { randomBytes, randomUUID } = require('node:crypto');
const { opaqueReady, opaqueServer } = require('@ultra-tasks/account-crypto');

opaqueReady.then(() => {
  const settings = {
    SERVER_IMAGE: 'ultra-tasks-server:dev',
    DOMAIN: 'localhost',
    PUBLIC_URL: 'http://localhost:1900',
    CORS_ORIGINS: 'http://localhost:1900',
    NODE_ENV: 'development',
    POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    ULTRA_SERVER_ID: randomUUID(),
    ULTRA_OPAQUE_SETUP: opaqueServer.createSetup(),
    ULTRA_AUTH_SECRET: randomBytes(32).toString('hex'),
    SMTP_HOST: 'mailpit',
    SMTP_PORT: '1025',
    SMTP_SECURE: 'false',
    SMTP_FROM: 'Ultra Tasks development <noreply@example.test>',
  };
  // Output is redirected by dev.sh into a private file, never a CI log.
  process.stdout.write(
    Object.entries(settings)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
  );
});
