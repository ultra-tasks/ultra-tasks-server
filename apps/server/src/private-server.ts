import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfigFromEnv, type ServerConfig } from './config';
import { prisma } from './db';
import { sendUltraAccountEmail } from './email';
import { loadUltraConfig, ultraAccountRoutes } from './ultra-account';

/** The v1 entry point exposes accounts and personal sync, independently of legacy routes. */
export const createServer = (overrides: Partial<ServerConfig> = {}) => {
  const config = loadConfigFromEnv(overrides);
  if (!process.env.CORS_ORIGINS && !overrides.cors)
    config.cors.allowedOrigins = [new URL(config.publicUrl).origin];
  const accountConfig = loadUltraConfig(config.publicUrl);
  const turnstileSiteKey = process.env.ULTRA_TURNSTILE_SITE_KEY || '';
  const turnstileSecret = process.env.ULTRA_TURNSTILE_SECRET_KEY || '';
  if (!!turnstileSiteKey !== !!turnstileSecret)
    throw new Error(
      'Configure both ULTRA_TURNSTILE_SITE_KEY and ULTRA_TURNSTILE_SECRET_KEY',
    );
  const turnstile = turnstileSiteKey
    ? {
        siteKey: turnstileSiteKey,
        secret: turnstileSecret,
        hostname: new URL(config.publicUrl).hostname,
      }
    : undefined;
  if (!accountConfig)
    throw new Error('Ultra Tasks server requires ULTRA_ACCOUNTS_ENABLED=true');
  let app: FastifyInstance | undefined;
  const production = process.env.NODE_ENV === 'production';
  const registrationOpen =
    process.env.ULTRA_REGISTRATION_OPEN === 'true' ||
    (!production && process.env.ULTRA_REGISTRATION_OPEN !== 'false');
  const legalDir = resolve(process.env.ULTRA_LEGAL_DIR || 'operator/legal');
  const hasPrivacy = existsSync(resolve(legalDir, 'privacy.html'));
  const hasTerms = existsSync(resolve(legalDir, 'terms.html'));
  const requireConsent =
    process.env.ULTRA_REQUIRE_TERMS_CONSENT === undefined
      ? production
      : process.env.ULTRA_REQUIRE_TERMS_CONSENT === 'true';
  if (registrationOpen && requireConsent && !hasPrivacy)
    throw new Error('Provide operator/legal/privacy.html before opening registration');

  return {
    get fastifyServer(): FastifyInstance | undefined {
      return app;
    },
    async start(): Promise<string> {
      app = Fastify({
        logger: false,
        bodyLimit: 8 * 1024 * 1024,
        requestTimeout: 80000,
        connectionTimeout: 90000,
        trustProxy: config.trustProxy,
      });
      app.setErrorHandler((error: FastifyError, _request, reply) => {
        const status = error.statusCode ?? 500;
        return reply.code(status).send({
          error: status >= 500 ? 'Internal server error' : 'Request rejected',
        });
      });
      await app.register(helmet, {
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
              "'self'",
              "'wasm-unsafe-eval'",
              ...(turnstile ? ['https://challenges.cloudflare.com'] : []),
            ],
            frameSrc: [
              "'self'",
              ...(turnstile ? ['https://challenges.cloudflare.com'] : []),
            ],
            connectSrc: [
              "'self'",
              ...(turnstile ? ['https://challenges.cloudflare.com'] : []),
            ],
            styleSrc: ["'self'"],
            frameAncestors: ["'none'"],
            baseUri: ["'none'"],
            formAction: ["'self'"],
          },
        },
        referrerPolicy: { policy: 'no-referrer' },
      });
      await app.register(rateLimit, { max: 500, timeWindow: '15 minutes' });
      await app.register(cors, {
        origin: config.cors.enabled ? config.cors.allowedOrigins : false,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Authorization', 'Content-Type'],
      });
      await app.register(websocket);
      await app.register(fastifyStatic, {
        root: resolve(process.cwd(), 'account-public'),
        index: false,
        cacheControl: false,
      });
      await app.register(ultraAccountRoutes, {
        prefix: '/api/v2/accounts',
        db: prisma,
        transaction: (run) =>
          prisma.$transaction(run, { maxWait: 10000, timeout: 30000 }),
        config: { ...accountConfig, privateOnly: true },
        registrationOpen,
        turnstile,
        requireTermsConsent: requireConsent,
        hasOperatorTerms: hasTerms,
        sendMail: sendUltraAccountEmail,
      });
      app.get('/', async (_request, reply) => reply.redirect('/account'));
      for (const [name, available] of [
        ['privacy', hasPrivacy],
        ['terms', hasTerms],
      ] as const) {
        if (available)
          app.get('/' + name + '.html', async (_request, reply) =>
            reply.header('Cache-Control', 'no-store').sendFile(name + '.html', legalDir),
          );
      }
      app.get('/account', async (_request, reply) =>
        reply.header('Cache-Control', 'no-store').sendFile('ultra-account.html'),
      );
      app.get('/live', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
      app.get('/health', { config: { rateLimit: false } }, async (_request, reply) => {
        try {
          await prisma.$queryRaw`SELECT 1`;
          return { status: 'ok' };
        } catch {
          return reply.code(503).send({ status: 'unavailable' });
        }
      });
      return app.listen({ host: config.host, port: config.port });
    },
    async stop(): Promise<void> {
      await app?.close();
    },
  };
};
