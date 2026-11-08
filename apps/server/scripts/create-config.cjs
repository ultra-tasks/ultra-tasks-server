const { randomBytes, randomUUID } = require('node:crypto');
const { opaqueReady, opaqueServer } = require('@ultra-tasks/account-crypto');
const publicUrl = new URL(process.argv[2]);
if (
  publicUrl.protocol !== 'https:' ||
  publicUrl.username ||
  publicUrl.password ||
  publicUrl.pathname !== '/' ||
  publicUrl.search ||
  publicUrl.hash
)
  throw new Error(
    'Provide an HTTPS origin without credentials, paths, or query parameters',
  );
opaqueReady.then(() => {
  // setup.sh redirects the complete output into a protected file, never a log.
  const settings = {
    SERVER_IMAGE: process.argv[3] || 'ultra-tasks-server:local',
    DOMAIN: publicUrl.hostname,
    PUBLIC_URL: publicUrl.origin,
    CORS_ORIGINS: publicUrl.origin,
    POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    ULTRA_SERVER_ID: randomUUID(),
    ULTRA_OPAQUE_SETUP: opaqueServer.createSetup(),
    ULTRA_AUTH_SECRET: randomBytes(32).toString('hex'),
    ULTRA_AUTH_ENGINE: 'better-auth',
    ULTRA_REGISTRATION_OPEN: 'false',
    ULTRA_REQUIRE_TERMS_CONSENT: 'true',
    SMTP_HOST: '',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_USER: '',
    SMTP_PASS: '',
    SMTP_FROM: '',
  };
  process.stdout.write(
    Object.entries(settings)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
  );
});
