/**
 * Tests for the rolling token refresh feature.
 *
 * Part A: Unit tests for createRefreshedToken (real auth module)
 * Part B: Integration tests for onSend hook on sync routes (mocked auth)
 * Part C: Verify the hook does NOT fire on non-sync (API) routes
 */
import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as jwt from 'jsonwebtoken';
import { uuidv7 } from 'uuidv7';

// Mock middleware so authenticate sets req.user for all route tests (Part B and C).
// The authenticate mock sets req.user so the onSend hook in sync.routes.ts can read it.
vi.mock('../src/middleware', () => ({
  authenticate: vi.fn().mockImplementation(async (req: any) => {
    req.user = { userId: 1, email: 'test@test.com', tokenVersion: 0 };
  }),
  getAuthUser: vi
    .fn()
    .mockReturnValue({ userId: 1, email: 'test@test.com', tokenVersion: 0 }),
}));

// ============================================================================
// Part A: createRefreshedToken unit tests (real auth module)
// ============================================================================
describe('createRefreshedToken (real implementation)', () => {
  const TEST_JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long-for-jwt';
  let createRefreshedToken: typeof import('../src/auth').createRefreshedToken;
  let verifyToken: typeof import('../src/auth').verifyToken;
  let prisma: any;

  beforeEach(async () => {
    // Set JWT_SECRET env var before importing real auth module
    process.env.JWT_SECRET = TEST_JWT_SECRET;

    // Get the real auth functions (bypasses the global mock from setup.ts)
    const realAuth = await vi.importActual<typeof import('../src/auth')>('../src/auth');
    createRefreshedToken = realAuth.createRefreshedToken;
    verifyToken = realAuth.verifyToken;

    // Get the mocked prisma for setting up DB state
    const dbModule = await import('../src/db');
    prisma = dbModule.prisma;
  });

  it('should return a valid JWT string with 3 dot-separated parts', () => {
    // Act
    const token = createRefreshedToken(1, 'test@example.com', 0);

    // Assert
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3);
  });

  it('should contain the correct userId claim', () => {
    // Arrange
    const userId = 42;

    // Act
    const token = createRefreshedToken(userId, 'user@test.com', 0);
    const decoded = jwt.decode(token) as jwt.JwtPayload;

    // Assert
    expect(decoded.userId).toBe(userId);
  });

  it('should contain the correct email claim', () => {
    // Arrange
    const email = 'alice@example.com';

    // Act
    const token = createRefreshedToken(1, email, 0);
    const decoded = jwt.decode(token) as jwt.JwtPayload;

    // Assert
    expect(decoded.email).toBe(email);
  });

  it('should contain the correct tokenVersion claim', () => {
    // Arrange
    const tokenVersion = 5;

    // Act
    const token = createRefreshedToken(1, 'test@test.com', tokenVersion);
    const decoded = jwt.decode(token) as jwt.JwtPayload;

    // Assert
    expect(decoded.tokenVersion).toBe(tokenVersion);
  });

  it('should NOT increment tokenVersion in the database', () => {
    // Arrange
    vi.clearAllMocks();

    // Act
    createRefreshedToken(1, 'test@test.com', 0);

    // Assert -- no DB writes should have occurred
    if (prisma.user?.update) {
      expect(prisma.user.update).not.toHaveBeenCalled();
    }
  });

  it('should produce a token that passes verifyToken when tokenVersion matches DB', async () => {
    // Arrange -- mock prisma.user.findUnique to return a user with matching tokenVersion
    (prisma.user.findUnique as Mock).mockResolvedValueOnce({
      id: 1,
      tokenVersion: 3,
    });

    // Act
    const token = createRefreshedToken(1, 'user@test.com', 3);
    const result = await verifyToken(token);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.userId).toBe(1);
    expect(result!.email).toBe('user@test.com');
    expect(result!.tokenVersion).toBe(3);
  });

  it('should produce a token rejected by verifyToken when tokenVersion does not match DB', async () => {
    // Arrange -- DB user has tokenVersion 5, but token has tokenVersion 3
    (prisma.user.findUnique as Mock).mockResolvedValueOnce({
      id: 1,
      tokenVersion: 5,
    });

    // Act
    const token = createRefreshedToken(1, 'user@test.com', 3);
    const result = await verifyToken(token);

    // Assert
    expect(result).toBeNull();
  });
});

// ============================================================================
// Part B: onSend hook integration tests (mocked auth, HTTP-level)
// ============================================================================
describe('onSend hook - X-Refreshed-Token header on sync routes', () => {
  let app: FastifyInstance;
  const authToken = 'mock-token';

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset the mocked auth to ensure createRefreshedToken is properly set
    const authMock = await import('../src/auth');
    (authMock.verifyToken as Mock).mockResolvedValue({
      userId: 1,
      email: 'test@test.com',
      tokenVersion: 0,
    });
    (authMock.createRefreshedToken as Mock).mockReturnValue('mock-refreshed-token');

    // Re-apply middleware mock after clearAllMocks
    const middlewareMock = await import('../src/middleware');
    (middlewareMock.authenticate as Mock).mockImplementation(async (req: any) => {
      req.user = { userId: 1, email: 'test@test.com', tokenVersion: 0 };
    });
    (middlewareMock.getAuthUser as Mock).mockReturnValue({
      userId: 1,
      email: 'test@test.com',
      tokenVersion: 0,
    });

    // Set up prisma mock to support user storage quota checks
    const dbModule = await import('../src/db');
    const prismaMock = dbModule.prisma as any;
    if (prismaMock.user?.findUnique) {
      (prismaMock.user.findUnique as Mock).mockResolvedValue({
        id: 1,
        storageQuotaBytes: BigInt(100 * 1024 * 1024),
        storageUsedBytes: BigInt(0),
      });
    }

    // Initialize sync service
    const { initSyncService } = await import('../src/sync/sync.service');
    initSyncService();

    // Create Fastify app with sync routes
    const { syncRoutes } = await import('../src/sync/sync.routes');
    app = Fastify();
    await app.register(syncRoutes, { prefix: '/api/sync' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // Helper to create a valid operation payload
  const createOp = (clientId: string, overrides: Record<string, unknown> = {}) => ({
    id: uuidv7(),
    clientId,
    actionType: 'ADD_TASK',
    opType: 'CRT',
    entityType: 'TASK',
    entityId: 'task-1',
    payload: { title: 'Test Task' },
    vectorClock: {},
    timestamp: Date.now(),
    schemaVersion: 1,
    ...overrides,
  });

  it('should include X-Refreshed-Token header on successful POST /api/sync/ops', async () => {
    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/ops',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        ops: [createOp('test-client')],
        clientId: 'test-client',
      },
    });

    // Assert
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-refreshed-token']).toBe('mock-refreshed-token');
  });

  it('should include X-Refreshed-Token header on successful GET /api/sync/ops', async () => {
    // Act
    const response = await app.inject({
      method: 'GET',
      url: '/api/sync/ops?sinceSeq=0',
      headers: { authorization: `Bearer ${authToken}` },
    });

    // Assert
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-refreshed-token']).toBe('mock-refreshed-token');
  });

  it('should include X-Refreshed-Token header on successful GET /api/sync/status', async () => {
    // Act
    const response = await app.inject({
      method: 'GET',
      url: '/api/sync/status',
      headers: { authorization: `Bearer ${authToken}` },
    });

    // Assert
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-refreshed-token']).toBe('mock-refreshed-token');
  });

  it('should NOT include X-Refreshed-Token header on error responses', async () => {
    // Act -- send invalid payload to trigger a 400 validation error
    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/ops',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        // Missing required 'ops' and 'clientId' fields
        invalid: true,
      },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    expect(response.headers['x-refreshed-token']).toBeUndefined();
  });

  it('should call createRefreshedToken with correct userId, email, and tokenVersion', async () => {
    // Arrange
    const authMock = await import('../src/auth');

    // Act
    await app.inject({
      method: 'GET',
      url: '/api/sync/status',
      headers: { authorization: `Bearer ${authToken}` },
    });

    // Assert
    expect(authMock.createRefreshedToken).toHaveBeenCalledWith(1, 'test@test.com', 0);
  });
});

// ============================================================================
// Part C: Verify the hook does NOT fire on non-sync (API) routes
// ============================================================================
describe('Non-sync routes should NOT include X-Refreshed-Token', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset auth mock to include replaceToken for the API route handler
    const authMock = await import('../src/auth');
    (authMock.createRefreshedToken as Mock).mockReturnValue('mock-refreshed-token');
    (authMock as any).replaceToken = vi.fn().mockResolvedValue({
      token: 'new-token',
      user: { id: 1, email: 'test@test.com' },
    });

    // Re-apply middleware mock after clearAllMocks
    const middlewareMock = await import('../src/middleware');
    (middlewareMock.authenticate as Mock).mockImplementation(async () => {});
    (middlewareMock.getAuthUser as Mock).mockReturnValue({
      userId: 1,
      email: 'test@test.com',
      tokenVersion: 0,
    });

    // Create Fastify app with apiRoutes (NOT syncRoutes)
    const { apiRoutes } = await import('../src/api');
    app = Fastify();
    await app.register(apiRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should NOT include X-Refreshed-Token header on POST /api/replace-token', async () => {
    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/replace-token',
      headers: { authorization: 'Bearer mock-token' },
    });

    // Assert
    expect(response.headers['x-refreshed-token']).toBeUndefined();
  });
});
