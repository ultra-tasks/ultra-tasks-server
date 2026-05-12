import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as zlib from 'zlib';
import { promisify } from 'util';

const mocks = vi.hoisted(() => {
  const syncService = {
    isRateLimited: vi.fn(),
    checkRequestDeduplication: vi.fn(),
    checkStorageQuota: vi.fn(),
    uploadOps: vi.fn(),
    cacheRequestResults: vi.fn(),
    cacheSnapshot: vi.fn(),
    prepareSnapshotCache: vi.fn(),
    updateStorageUsage: vi.fn(),
    incrementStorageUsage: vi.fn(),
    decrementStorageUsage: vi.fn(),
    getLatestSeq: vi.fn(),
    getOpsSinceWithSeq: vi.fn(),
    getStorageInfo: vi.fn(),
    getCachedSnapshotBytes: vi.fn(),
  };

  return {
    syncService,
    notifyNewOps: vi.fn(),
  };
});

vi.mock('../src/auth', () => ({
  verifyToken: vi.fn().mockResolvedValue({
    valid: true,
    userId: 1,
    email: 'test@test.com',
  }),
}));

vi.mock('../src/sync/sync.service', () => ({
  getSyncService: () => mocks.syncService,
}));

vi.mock('../src/sync/services/websocket-connection.service', () => ({
  getWsConnectionService: () => ({
    notifyNewOps: mocks.notifyNewOps,
  }),
}));

import { syncRoutes } from '../src/sync/sync.routes';

const gzipAsync = promisify(zlib.gzip);

const createOp = (clientId: string) => ({
  id: 'op-1',
  clientId,
  actionType: 'ADD_TASK',
  opType: 'CRT',
  entityType: 'TASK',
  entityId: 'task-1',
  payload: { title: 'Test Task' },
  vectorClock: {},
  timestamp: Date.now(),
  schemaVersion: 1,
});

describe('Sync compressed body routes', () => {
  let app: FastifyInstance;
  const authToken = 'mock-token';

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.syncService.isRateLimited.mockReturnValue(false);
    mocks.syncService.checkRequestDeduplication.mockReturnValue(undefined);
    mocks.syncService.checkStorageQuota.mockResolvedValue({
      allowed: true,
      currentUsage: 0,
      quota: 100 * 1024 * 1024,
    });
    mocks.syncService.uploadOps.mockResolvedValue([{ accepted: true, serverSeq: 1 }]);
    mocks.syncService.cacheSnapshot.mockResolvedValue({
      cached: true,
      bytesWritten: 0,
      previousBytes: 0,
      deltaBytes: 0,
    });
    mocks.syncService.prepareSnapshotCache.mockImplementation((state: unknown) => {
      const serialized = JSON.stringify(state);
      const data = zlib.gzipSync(serialized);
      return {
        data,
        bytes: data.length,
        stateBytes: Buffer.byteLength(serialized, 'utf8'),
        cacheable: true,
      };
    });
    mocks.syncService.updateStorageUsage.mockResolvedValue(undefined);
    mocks.syncService.incrementStorageUsage.mockResolvedValue(undefined);
    mocks.syncService.decrementStorageUsage.mockResolvedValue(undefined);
    mocks.syncService.getLatestSeq.mockResolvedValue(1);
    mocks.syncService.getOpsSinceWithSeq.mockResolvedValue({
      ops: [],
      latestSeq: 1,
    });
    mocks.syncService.getStorageInfo.mockResolvedValue({
      storageUsedBytes: 0,
      storageQuotaBytes: 100 * 1024 * 1024,
    });
    mocks.syncService.getCachedSnapshotBytes.mockResolvedValue(0);

    app = Fastify();
    await app.register(syncRoutes, { prefix: '/api/sync' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should accept plain JSON ops upload', async () => {
    const clientId = 'plain-json-client';

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/ops',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        ops: [createOp(clientId)],
        clientId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].accepted).toBe(true);
    expect(mocks.syncService.uploadOps).toHaveBeenCalledOnce();
  });

  it('should accept base64 gzip ops upload', async () => {
    const clientId = 'base64-gzip-client';
    const payload = {
      ops: [createOp(clientId)],
      clientId,
    };
    const compressedPayload = await gzipAsync(
      Buffer.from(JSON.stringify(payload), 'utf-8'),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/ops',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-transfer-encoding': 'base64',
      },
      payload: compressedPayload.toString('base64'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].accepted).toBe(true);
    expect(mocks.syncService.uploadOps).toHaveBeenCalledOnce();
  });

  it('should preserve the invalid gzip route response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/ops',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: Buffer.from('not valid gzip data', 'utf-8'),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('Failed to decompress gzip body');
    expect(mocks.syncService.uploadOps).not.toHaveBeenCalled();
  });

  it('should reject clean-slate snapshot when replacement exceeds quota', async () => {
    const clientId = 'clean-slate-quota-client';
    mocks.syncService.prepareSnapshotCache.mockReturnValueOnce({
      data: Buffer.from('cached-snapshot'),
      bytes: 80,
      stateBytes: 30,
      cacheable: true,
    });
    mocks.syncService.getStorageInfo.mockResolvedValueOnce({
      storageUsedBytes: 1000,
      storageQuotaBytes: 100,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/snapshot',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        state: { TASK: { 'task-1': { id: 'task-1' } } },
        clientId,
        reason: 'initial',
        vectorClock: {},
        isCleanSlate: true,
      },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().errorCode).toBe('STORAGE_QUOTA_EXCEEDED');
    expect(mocks.syncService.uploadOps).not.toHaveBeenCalled();
  });

  it('should count snapshot op bytes and cache replacement delta after upload', async () => {
    const clientId = 'snapshot-delta-client';
    const vectorClock = { [clientId]: 1 };
    const preparedSnapshot = {
      data: Buffer.from('cached-snapshot'),
      bytes: 40,
      stateBytes: 25,
      cacheable: true,
    };
    mocks.syncService.prepareSnapshotCache.mockReturnValueOnce(preparedSnapshot);
    mocks.syncService.getCachedSnapshotBytes.mockResolvedValueOnce(10);
    mocks.syncService.uploadOps.mockResolvedValueOnce([{ accepted: true, serverSeq: 7 }]);
    mocks.syncService.cacheSnapshot.mockResolvedValueOnce({
      cached: true,
      bytesWritten: 40,
      previousBytes: 10,
      deltaBytes: 30,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/snapshot',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        state: { TASK: { 'task-1': { id: 'task-1' } } },
        clientId,
        reason: 'recovery',
        vectorClock,
      },
    });

    const vectorClockBytes = Buffer.byteLength(JSON.stringify(vectorClock), 'utf8');
    const expectedDelta = preparedSnapshot.stateBytes + vectorClockBytes + 30;

    expect(response.statusCode).toBe(200);
    expect(mocks.syncService.checkStorageQuota).toHaveBeenCalledWith(1, expectedDelta);
    expect(mocks.syncService.cacheSnapshot).toHaveBeenCalledWith(
      1,
      { TASK: { 'task-1': { id: 'task-1' } } },
      7,
      preparedSnapshot,
    );
    expect(mocks.syncService.incrementStorageUsage).toHaveBeenCalledWith(
      1,
      expectedDelta,
    );
  });
});
