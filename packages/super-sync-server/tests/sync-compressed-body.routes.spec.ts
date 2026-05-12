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
    updateStorageUsage: vi.fn(),
    freeStorageForUpload: vi.fn(),
    getLatestSeq: vi.fn(),
    getOpsSinceWithSeq: vi.fn(),
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
    mocks.syncService.cacheSnapshot.mockResolvedValue(undefined);
    mocks.syncService.updateStorageUsage.mockResolvedValue(undefined);
    mocks.syncService.freeStorageForUpload.mockResolvedValue({
      success: false,
      freedBytes: 0,
      deletedRestorePoints: 0,
      deletedOps: 0,
    });
    mocks.syncService.getLatestSeq.mockResolvedValue(1);
    mocks.syncService.getOpsSinceWithSeq.mockResolvedValue({
      ops: [],
      latestSeq: 1,
    });

    app = Fastify();
    await app.register(syncRoutes, { prefix: '/api/sync' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should accept plain JSON ops upload', async () => {
    const clientId = 'plain-json-client';
    const payload = {
      ops: [createOp(clientId)],
      clientId,
    };
    const jsonPayload = JSON.stringify(payload);
    const payloadSize = Buffer.byteLength(jsonPayload, 'utf-8');

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/ops',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
        'content-length': String(payloadSize),
      },
      payload: jsonPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].accepted).toBe(true);
    expect(mocks.syncService.uploadOps).toHaveBeenCalledOnce();
    expect(mocks.syncService.checkStorageQuota).toHaveBeenCalledWith(1, payloadSize);
  });

  it('should fall back to UTF-8 JSON byte size for plain JSON without content-length', async () => {
    const clientId = 'plain-json-client';
    const payload = {
      ops: [
        createOp(clientId),
        {
          ...createOp(clientId),
          id: 'op-unicode',
          entityId: 'task-unicode',
          payload: { title: 'Übergrößenträger 🚀' },
        },
      ],
      clientId,
    };
    const jsonPayload = JSON.stringify(payload);

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/ops',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
        'content-length': 'not-a-number',
      },
      payload: jsonPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.syncService.checkStorageQuota).toHaveBeenCalledWith(
      1,
      Buffer.byteLength(jsonPayload, 'utf-8'),
    );
    expect(Buffer.byteLength(jsonPayload, 'utf-8')).toBeGreaterThan(jsonPayload.length);
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
    const decompressedSize = Buffer.byteLength(JSON.stringify(payload), 'utf-8');

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
    expect(mocks.syncService.checkStorageQuota).toHaveBeenCalledWith(1, decompressedSize);
    expect(decompressedSize).not.toBe(
      Buffer.byteLength(compressedPayload.toString('base64'), 'utf-8'),
    );
  });

  it('should skip snapshot metadata for upload piggyback downloads', async () => {
    const clientId = 'plain-json-client';
    const payload = {
      ops: [createOp(clientId)],
      clientId,
      lastKnownServerSeq: 0,
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/ops',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.syncService.getOpsSinceWithSeq).toHaveBeenCalledWith(
      1,
      0,
      clientId,
      500,
      false,
    );
  });

  it('should skip snapshot metadata for deduplicated retry piggyback downloads', async () => {
    const clientId = 'plain-json-client';
    const cachedResults = [{ accepted: true, serverSeq: 1 }];
    mocks.syncService.checkRequestDeduplication.mockReturnValue(cachedResults);
    mocks.syncService.getOpsSinceWithSeq.mockResolvedValue({
      ops: [],
      latestSeq: 4,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/ops',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
      },
      payload: {
        ops: [createOp(clientId)],
        clientId,
        lastKnownServerSeq: 3,
        requestId: 'retry-request',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      results: cachedResults,
      latestSeq: 4,
      deduplicated: true,
    });
    expect(mocks.syncService.checkStorageQuota).not.toHaveBeenCalled();
    expect(mocks.syncService.getOpsSinceWithSeq).toHaveBeenCalledWith(
      1,
      3,
      clientId,
      500,
      false,
    );
  });

  it('should charge compressed snapshot uploads by decompressed JSON size', async () => {
    const clientId = 'base64-gzip-snapshot-client';
    const payload = {
      state: {
        tasks: {
          'task-1': { id: 'task-1', title: 'Snapshot Task' },
        },
      },
      clientId,
      reason: 'recovery',
      vectorClock: { [clientId]: 1 },
      schemaVersion: 1,
    };
    const jsonPayload = JSON.stringify(payload);
    const compressedPayload = await gzipAsync(Buffer.from(jsonPayload, 'utf-8'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/snapshot',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-transfer-encoding': 'base64',
      },
      payload: compressedPayload.toString('base64'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accepted).toBe(true);
    expect(mocks.syncService.cacheSnapshot).toHaveBeenCalledWith(1, payload.state, 1);
    expect(mocks.syncService.checkStorageQuota).toHaveBeenCalledWith(
      1,
      Buffer.byteLength(jsonPayload, 'utf-8'),
    );
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
});
