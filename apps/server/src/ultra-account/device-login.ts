import {
  AccountError,
  assertSessionCapacity,
  challenge,
  type UltraConfig,
} from './security';
import { factors, publicAccount, type AccountRow, type UltraDb } from './store';
import {
  findTrustedDevice,
  issueTrustedSession,
  startDeviceChallenge,
  type DeviceTrust,
  type DeviceVerification,
} from './device-store';

/** What a client that cannot show the code step is told; it never receives a session. */
export const clientUpdateRequired = (): AccountError =>
  new AccountError(
    426,
    'Update Ultra Tasks to sign in on a new device.',
    'client_update_required',
  );

/** Stored with an MFA challenge so the device is recorded once the second factor passes. */
export interface MfaLoginData {
  deviceName: string;
  deviceEmail?: boolean;
  deviceDigest?: string;
}
export const mfaLoginData = (deviceName: string, trust: DeviceTrust): MfaLoginData =>
  trust.enabled
    ? {
        deviceName,
        deviceEmail: true,
        ...(trust.digest ? { deviceDigest: trust.digest } : {}),
      }
    : { deviceName };
/** The feature may have been switched off since the challenge was created: then no device is recorded. */
export const mfaTrust = (data: MfaLoginData, featureOn: boolean): DeviceTrust => ({
  enabled: featureOn && data.deviceEmail === true,
  digest: data.deviceDigest,
});

/** A session body: tokens, the account and, when newly trusted, the device token. */
export const openSession = async (
  tx: UltraDb,
  config: UltraConfig,
  account: AccountRow,
  deviceName: string,
  trust: DeviceTrust,
) => {
  const { tokens, deviceToken } = await issueTrustedSession(
    tx,
    config,
    account.id,
    deviceName,
    trust,
  );
  return {
    ...tokens,
    account: publicAccount(account),
    ...(deviceToken ? { deviceToken } : {}),
  };
};

export type LoginDecision =
  | { kind: 'body'; body: Record<string, unknown> }
  | {
      kind: 'email';
      email: string;
      token: string;
      code: string;
      verification: DeviceVerification;
    };

/**
 * The order is fixed: enrolled factors first (email never replaces or adds to them), then the
 * email policy for an unrecognised device, otherwise a session. The caller has locked the
 * account and checked that its email is verified, and sends any email after committing.
 */
export const decideLogin = async (
  tx: UltraDb,
  policy: { config: UltraConfig; deviceEmail: boolean },
  account: AccountRow,
  deviceName: string,
  trust: DeviceTrust,
): Promise<LoginDecision> => {
  const { config } = policy;
  const enrolled = await factors(tx, account.id);
  if (enrolled.length)
    return {
      kind: 'body',
      body: {
        mfaToken: await challenge(
          tx,
          config,
          'mfa',
          account.id,
          mfaLoginData(deviceName, trust),
        ),
        factors: [...new Set(enrolled.map((factor) => factor.kind))],
      },
    };
  if (
    policy.deviceEmail &&
    account.new_device_email &&
    !(trust.digest && (await findTrustedDevice(tx, config, account.id, trust.digest)))
  ) {
    if (!trust.enabled) throw clientUpdateRequired();
    await assertSessionCapacity(tx, account.id);
    const pending = await startDeviceChallenge(tx, config, account, deviceName);
    return { kind: 'email', email: account.email, ...pending };
  }
  return {
    kind: 'body',
    body: await openSession(tx, config, account, deviceName, trust),
  };
};
