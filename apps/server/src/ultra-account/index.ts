import { UltraConfig } from './security';

export { ultraAccountRoutes } from './routes';
export const loadUltraConfig = (publicUrl: string): UltraConfig | undefined => {
  if (process.env.ULTRA_ACCOUNTS_ENABLED !== 'true') return;
  const serverId = process.env.ULTRA_SERVER_ID ?? '';
  const opaqueSetup = process.env.ULTRA_OPAQUE_SETUP ?? '';
  const authSecret = process.env.ULTRA_AUTH_SECRET ?? '';
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      serverId,
    ) ||
    !opaqueSetup ||
    authSecret.length < 32
  )
    throw new Error(
      'Ultra accounts require a stable ULTRA_SERVER_ID, ULTRA_OPAQUE_SETUP, and ULTRA_AUTH_SECRET (32+ characters)',
    );
  return {
    serverId,
    opaqueSetup,
    authSecret,
    publicUrl: new URL(publicUrl).origin,
    rpId: new URL(publicUrl).hostname,
  };
};
