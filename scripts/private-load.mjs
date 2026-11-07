import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import {
  AccountClient,
  SyncClient,
  RealtimeSync,
  createRealtimeSocket,
  httpTransport,
} from '@ultra-tasks/account-crypto';

const fixture = JSON.parse(readFileSync(0, 'utf8'));
const devices = Number(process.env.ULTRA_LOAD_DEVICES || 8);
const records = Number(process.env.ULTRA_LOAD_RECORDS || 100);
const rounds = 5;
assert.ok(Number.isInteger(devices) && devices >= 2 && devices <= 12);
assert.ok(Number.isInteger(records) && records >= 1 && records <= 1000);
const metrics = {
  devices,
  recordsPerDevice: records,
  rounds,
  requests: 0,
  requestJsonBytes: 0,
  responseJsonBytes: 0,
  elapsedMs: 0,
  p95RequestMs: 0,
  p95ForegroundMs: 0,
  p99ForegroundMs: 0,
  peakServerMemoryMiB: 0,
  peakServerCpuPercent: 0,
  databaseBytesBefore: 0,
  databaseBytesAfter: 0,
  quotaRetained: false,
};
const times = [];
const base = httpTransport('http://127.0.0.1:1900');
const transport = async (...args) => {
  const start = performance.now();
  metrics.requests++;
  if (args[1]) metrics.requestJsonBytes += Buffer.byteLength(JSON.stringify(args[1]));
  try {
    const result = await base(...args);
    metrics.responseJsonBytes += Buffer.byteLength(JSON.stringify(result));
    return result;
  } finally {
    times.push(performance.now() - start);
  }
};
const compose = (...args) =>
  execFileSync('sh', ['scripts/compose.sh', ...args], { encoding: 'utf8' }).trim();
const databaseSize = () =>
  Number(
    compose(
      'exec',
      '-T',
      'postgres',
      'psql',
      '-X',
      '-U',
      'ultra',
      '-d',
      'ultra',
      '-Atc',
      "SELECT pg_database_size('ultra')",
    ),
  );
assert.equal((await transport('/capabilities')).serverId, fixture.serverId);
const container = compose('ps', '-q', 'server');
assert.ok(container, 'The isolated development stack must be running');
const monitor = spawn(
  'docker',
  ['stats', '--format', '{{.MemUsage}}|{{.CPUPerc}}', container],
  { stdio: ['ignore', 'pipe', 'ignore'] },
);
monitor.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    const memory = line.match(/([\d.]+)([KMG]?i?B)/);
    const cpu = line.match(/\|([\d.]+)%/);
    if (memory) {
      const unit = memory[2];
      const factor =
        unit === 'GiB'
          ? 1024
          : unit === 'GB'
            ? 1000 ** 3 / 1024 ** 2
            : unit === 'MiB'
              ? 1
              : unit === 'MB'
                ? 1000 ** 2 / 1024 ** 2
                : unit === 'KiB'
                  ? 1 / 1024
                  : unit === 'kB'
                    ? 1000 / 1024 ** 2
                    : 1 / 1024 ** 2;
      metrics.peakServerMemoryMiB = Math.max(
        metrics.peakServerMemoryMiB,
        Number(memory[1]) * factor,
      );
    }
    if (cpu)
      metrics.peakServerCpuPercent = Math.max(
        metrics.peakServerCpuPercent,
        Number(cpu[1]),
      );
  }
});
try {
  metrics.databaseBytesBefore = databaseSize();
  const start = performance.now();
  const clients = [];
  const stores = [];
  for (let i = 0; i < devices; i++) {
    const account = new AccountClient(transport);
    await account.login(fixture.email, fixture.password);
    let state = null;
    const storage = {
      load: async () => structuredClone(state),
      save: async (next) => {
        state = structuredClone(next);
      },
    };
    stores.push(storage);
    const client = new SyncClient(account, storage);
    await client.init();
    await client.refreshScopes();
    await client.syncScope(fixture.scope);
    clients.push(client);
  }
  console.log(`Capacity fixture: ${devices} independent signed-in devices ready`);
  const live = clients.map(
    (client) =>
      new RealtimeSync(client, {
        includePersonal: true,
        includeShared: false,
        fallbackMs: 60000,
        socket: (ticket) =>
          createRealtimeSocket(
            'ws://127.0.0.1:1900/api/v2/accounts/sync/events?ticket=' +
              encodeURIComponent(ticket),
          ),
        updated: () => {},
      }),
  );
  const waitFor = async (condition) => {
    const deadline = Date.now() + 15000;
    while (!condition()) {
      assert.ok(
        Date.now() < deadline,
        'Personal realtime did not converge before the acceptance deadline',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const delivery = [];
  try {
    live.forEach((scheduler) => scheduler.start());
    await waitFor(() => live.every((scheduler) => scheduler.isConnected));
    for (let counter = 1; counter <= 10; counter++) {
      const before = performance.now();
      await clients[0].edit(fixture.scope, [
        { entityId: 'latency-task', entityType: 'personal.task', value: { counter } },
      ]);
      await waitFor(() =>
        clients.every(
          (client) =>
            client.records(fixture.scope)['latency-task']?.value.counter === counter,
        ),
      );
      delivery.push(Math.round(performance.now() - before));
    }
  } finally {
    await Promise.all(live.map((scheduler) => scheduler.stop()));
  }
  delivery.sort((a, b) => a - b);
  metrics.p95ForegroundMs = delivery[Math.ceil(delivery.length * 0.95) - 1];
  metrics.p99ForegroundMs = delivery[Math.ceil(delivery.length * 0.99) - 1];
  assert.ok(
    metrics.p95ForegroundMs < 2000,
    'Ordinary foreground metadata notifications exceed the two-second target',
  );
  console.log('Private foreground delivery acceptance passed');
  await Promise.all(
    clients.map(async (client, device) => {
      for (let offset = 0; offset < records; offset += 100) {
        await client.edit(
          fixture.scope,
          Array.from({ length: Math.min(100, records - offset) }, (_, i) => ({
            entityId: `load-${device}-${offset + i}`,
            entityType: 'personal.task',
            value: {
              title: `Capacity task ${device}/${offset + i}`,
              notes: 'x'.repeat(1024),
              counter: 0,
            },
          })),
        );
      }
      assert.deepEqual(await client.syncAll(), {});
    }),
  );
  for (let round = 1; round <= rounds; round++) {
    await Promise.all(
      clients.map(async (client, device) => {
        await client.edit(fixture.scope, [
          {
            entityId: `load-${device}-0`,
            entityType: 'personal.task',
            value: {
              title: `Capacity task ${device}/0`,
              notes: 'x'.repeat(1024),
              counter: round,
            },
          },
        ]);
        assert.deepEqual(await client.syncAll(), {});
      }),
    );
  }
  for (const client of clients) {
    assert.deepEqual(await client.syncAll(), {});
    const values = client.records(fixture.scope);
    for (let device = 0; device < devices; device++) {
      assert.equal(values[`load-${device}-0`].value.counter, rounds);
      assert.ok(values[`load-${device}-${records - 1}`]);
    }
  }
  console.log('Concurrent private records converged on every device');
  if (process.env.ULTRA_LOAD_QUOTA === 'true') {
    const client = clients[0];
    let refused = false;
    for (let batch = 0; batch < 30; batch++) {
      await client.edit(
        fixture.scope,
        Array.from({ length: 100 }, (_, i) => ({
          entityId: `quota-${batch}-${i}`,
          entityType: 'personal.task',
          value: { notes: 'q'.repeat(16000) },
        })),
      );
      try {
        await client.syncScope(fixture.scope);
      } catch (error) {
        assert.equal(error.status, 413);
        const pending = client.state.scopes[fixture.scope].intents.length;
        assert.ok(pending > 0);
        const reopened = new SyncClient(client.account, stores[0]);
        await reopened.init();
        assert.equal(reopened.state.scopes[fixture.scope].intents.length, pending);
        refused = true;
        break;
      }
    }
    assert.ok(refused, 'The real encrypted-record quota must reject a full account');
    metrics.quotaRetained = true;
    console.log('Full-account quota retained pending intents across reopening');
  }
  metrics.elapsedMs = Math.round(performance.now() - start);
  times.sort((a, b) => a - b);
  metrics.p95RequestMs = Math.round(
    times[Math.max(0, Math.ceil(times.length * 0.95) - 1)],
  );
  metrics.databaseBytesAfter = databaseSize();
  writeFileSync('.tmp/private-load.json', JSON.stringify(metrics, null, 2) + '\n');
  console.log(
    'Real PostgreSQL private-sync capacity acceptance passed: ' + JSON.stringify(metrics),
  );
} finally {
  monitor.kill('SIGTERM');
}
