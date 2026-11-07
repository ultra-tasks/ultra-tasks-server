// Acceptance for the isolated development Compose stack only. No real mail is sent.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const {
  AccountClient,
  SyncClient,
  httpTransport,
} = require('@ultra-tasks/account-crypto');

const storage = () => {
  let state = null;
  return {
    async load() {
      return structuredClone(state);
    },
    async save(next) {
      state = structuredClone(next);
    },
  };
};

async function main() {
  assert.equal(
    process.env.NODE_ENV,
    'development',
    'This check requires the development stack',
  );
  assert.equal(
    process.env.SMTP_HOST,
    'mailpit',
    'This check requires isolated development mail',
  );
  const origin = 'http://127.0.0.1:1900';
  assert.equal((await fetch(origin + '/health')).status, 200);
  const dashboard = await fetch(origin + '/account');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get('cache-control'), 'no-store');
  for (const path of ['/api/register', '/api/login', '/api/sync/ops', '/index.html'])
    assert.equal((await fetch(origin + path)).status, 404);

  const transport = httpTransport(origin);
  const capabilities = await transport('/capabilities');
  assert.equal(capabilities.features.sharedProjects, false);
  assert.equal(capabilities.features.sharedRealtime, false);

  const username = 'smoke' + randomBytes(6).toString('hex');
  const email = username + '@example.test';
  const password = randomBytes(32).toString('hex');
  const firstAccount = new AccountClient(transport);
  const prepared = await firstAccount.prepareRegistration(
    { email, username, displayName: 'Docker acceptance' },
    password,
  );
  await firstAccount.register(prepared);

  let verification;
  for (let attempt = 0; attempt < 50 && !verification; attempt++) {
    const inbox = await (await fetch('http://mailpit:8025/api/v1/messages')).json();
    const item = inbox.messages.find((message) =>
      message.To.some((recipient) => recipient.Address === email),
    );
    if (item) {
      const message = await (
        await fetch('http://mailpit:8025/api/v1/message/' + item.ID)
      ).json();
      verification = message.Text.match(/[?&]verify=([A-Za-z0-9_-]+)/)?.[1];
    }
    if (!verification) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(verification, 'Development verification email was not delivered');
  await transport('/verify-email', { token: verification });
  await firstAccount.login(email, password);
  const first = new SyncClient(firstAccount, storage());
  await first.init();
  const scope = await first.migrate([
    {
      entityId: 'docker-task',
      entityType: 'personal.task',
      value: { title: 'Private Docker acceptance record' },
    },
  ]);
  const secondAccount = new AccountClient(transport);
  await secondAccount.login(email, password);
  const second = new SyncClient(secondAccount, storage());
  await second.init();
  await second.refreshScopes();
  await second.syncScope(scope);
  assert.equal(
    second.records(scope)['docker-task'].value.title,
    'Private Docker acceptance record',
  );
  await assert.rejects(first.createScope('project'), (error) => error.status === 403);
  // Do not print credentials, email links, recovery material, or user records.
  console.log(
    'Docker acceptance passed: PostgreSQL, migration, dashboard, email verification, two encrypted clients, private-only API',
  );
}

main().catch((error) => {
  console.error('Docker acceptance failed:', error.name, error.message);
  process.exitCode = 1;
});
