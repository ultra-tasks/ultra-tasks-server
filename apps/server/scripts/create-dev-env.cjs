const { randomBytes, randomUUID } = require('node:crypto');
const { opaqueReady, opaqueServer } = require('@ultra-tasks/account-crypto');

opaqueReady.then(() => {
  const settings = {
    SERVER_IMAGE: 'ultra-tasks-server:dev',
    DOMAIN: 'localhost',
    PUBLIC_URL: 'http://localhost:1900',
    CORS_ORIGINS: 'http://localhost:1900',
    NODE_ENV: 'development',
    ULTRA_REGISTRATION_OPEN: 'true',
    ULTRA_REQUIRE_TERMS_CONSENT: 'false',
    // The installation, load and smoke scripts sign in as many fresh devices without a person
    // to read the emailed code. The code step itself is covered by the account, device and
    // dashboard test suites; set this to true to try it by hand against the development stack.
    ULTRA_DEVICE_EMAIL_VERIFICATION: 'false',
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
