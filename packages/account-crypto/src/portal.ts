import { AccountClient, AccountInfo, Tokens, httpTransport } from './account-client';
import { AccountBundle, VaultContext, unlockBundle, context, open, seal } from './vault';

declare global {
  interface Window {
    SimpleWebAuthnBrowser: {
      startRegistration(input: { optionsJSON: object }): Promise<unknown>;
      startAuthentication(input: { optionsJSON: object }): Promise<unknown>;
    };
  }
}
const client = new AccountClient(httpTransport(location.origin));
const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const result = document.getElementById(id);
  if (!result) throw new Error('Missing account element');
  return result as T;
};
const value = (id: string): string => element<HTMLInputElement>(id).value;
const secret = (id: string): string => {
  const result = value(id);
  element<HTMLInputElement>(id).value = '';
  return result;
};
const show = (id: string, visible = true): void => {
  element(id).hidden = !visible;
};
const status = (message: string): void => {
  element('status').textContent = message;
};
let recoveryText = '';
let prepared: Awaited<ReturnType<AccountClient['prepareRegistration']>> | undefined;
let totpEnrollment: string | undefined;
let recoveryMailToken = '';

interface CachedProfile {
  origin: string;
  accountId: string;
  serverId: string;
  account: AccountInfo;
  bundle: AccountBundle;
  refresh: Awaited<ReturnType<typeof seal>>;
}
const profiles = async <T>(
  action: (store: IDBObjectStore) => IDBRequest<T>,
  write = false,
): Promise<T> => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ultra-account-v2', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('profiles', {
        keyPath: ['origin', 'serverId', 'accountId'],
      });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('profiles', write ? 'readwrite' : 'readonly');
      const request = action(tx.objectStore('profiles'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
};
const cache = async (): Promise<void> => {
  if (!client.account || !client.bundle || !client.unlocked || !client.tokens) return;
  const profile: CachedProfile = {
    origin: location.origin,
    ...client.identity(),
    account: client.account,
    bundle: client.bundle,
    refresh: await seal(
      client.unlocked.masterKey,
      client.tokens.refreshToken,
      context(client.identity(), 'browser-refresh'),
    ),
  };
  await profiles((store) => store.put(profile), true);
};
const signedIn = async (): Promise<void> => {
  show('mfa', false);
  show('auth', false);
  show('dashboard');
  element('who').textContent = client.account?.email ?? '';
  await cache();
  const info = await client.request<{ factors: { id: string; kind: string }[] }>('/me');
  element('factors').replaceChildren();
  for (const factor of info.factors) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = factor.kind + ' ';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      element<HTMLInputElement>('remove-factor-id').value = factor.id;
      show('remove-factor');
    });
    row.append(label, remove);
    element('factors').append(row);
  }
  element<HTMLInputElement>('profile-username').value = client.account?.username ?? '';
  element<HTMLInputElement>('profile-name').value = client.account?.displayName ?? '';
  status('Signed in. Your encrypted account keys are unlocked on this device.');
};
client.onTokensChanged = cache;
const run =
  (action: () => Promise<void>): ((event: Event) => Promise<void>) =>
  async (event: Event): Promise<void> => {
    event.preventDefault();
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
    for (const button of buttons) button.disabled = true;
    try {
      status('Working…');
      await action();
    } catch (error) {
      status(error instanceof Error ? error.message : 'Account action failed');
    } finally {
      for (const button of buttons) button.disabled = false;
    }
  };
const on = (id: string, action: () => Promise<void>): void =>
  element(id).addEventListener(
    element(id) instanceof HTMLFormElement ? 'submit' : 'click',
    run(action),
  );
const recoverySheet = (label: string, material: string): void => {
  recoveryText = `Ultra Tasks ${label}\nServer: ${location.origin}\nAccount: ${client.account?.email ?? value('signup-email')}\n\n${material}\n\nKeep this material private. Losing your password and vault recovery key, without an unlocked device, means losing access to encrypted data. MFA recovery codes recover login only and cannot decrypt data.`;
  element('recovery-material').textContent = material;
  element('recovery-label').textContent = label;
  show('recovery-sheet');
};
on('signup', async () => {
  const password = secret('signup-password');
  const confirmation = secret('signup-confirm');
  if (password !== confirmation) throw new Error('Passwords do not match');
  prepared = await client.prepareRegistration(
    {
      email: value('signup-email'),
      ...(value('signup-username') ? { username: value('signup-username') } : {}),
      displayName: value('signup-name'),
      termsAccepted: element<HTMLInputElement>('signup-consent-accepted').checked,
    },
    password,
  );
  recoverySheet('vault recovery key', prepared.recoveryKey);
  show('finish-signup');
  element<HTMLInputElement>('saved-key').checked = false;
  status('Save or print your recovery key before creating the account.');
});
on('finish-signup', async () => {
  if (!prepared || !element<HTMLInputElement>('saved-key').checked)
    throw new Error('Confirm that you saved the recovery key');
  await client.register(prepared);
  prepared = undefined;
  recoveryText = '';
  element('recovery-material').textContent = '';
  show('recovery-sheet', false);
  show('finish-signup', false);
  status('Check your email to verify the account, then sign in.');
});
on('copy-recovery', async () => {
  await navigator.clipboard.writeText(recoveryText);
  status('Recovery material copied. Store it in your password manager.');
});
on('download-recovery', async () => {
  const url = URL.createObjectURL(
    new Blob([recoveryText], { type: 'text/plain;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ultra-tasks-recovery.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('Keep the recovery file private.');
});
element('print-recovery').addEventListener('click', () => window.print());
on('login', async () => {
  const result = await client.login(
    value('login-id'),
    secret('login-password'),
    value('device-name'),
  );
  if (result.mfaToken) {
    show('mfa');
    show('webauthn-login', !!result.factors?.includes('webauthn'));
    status('Complete two-factor authentication.');
  } else await signedIn();
});
on('mfa', async () => {
  await client.completeMfa(secret('mfa-code'));
  await signedIn();
});
on('webauthn-login', async () => {
  const response = await client.webauthnLoginOptions();
  const credential = await window.SimpleWebAuthnBrowser.startAuthentication({
    optionsJSON: response.options,
  });
  await client.completeWebauthn(response.credentialToken, credential);
  await signedIn();
});
on('offline-unlock', async () => {
  const name = value('login-id').trim().toLowerCase();
  const password = secret('login-password');
  const records = (await profiles((store) => store.getAll())) as CachedProfile[];
  const profile = records.find(
    (record) =>
      record.origin === location.origin &&
      (record.account.email === name || record.account.username === name),
  );
  if (!profile) throw new Error('No cached account on this device');
  const identity: VaultContext = {
    serverId: profile.serverId,
    accountId: profile.accountId,
  };
  const unlocked = await unlockBundle(profile.bundle, identity, { password });
  client.account = profile.account;
  client.bundle = profile.bundle;
  client.unlocked = unlocked;
  status('Cached account unlocked offline. Server actions require an online session.');
  element('who').textContent = profile.account.email;
  show('offline-state');
});
on('resume-session', async () => {
  if (!client.account || !client.unlocked)
    throw new Error('Unlock the cached account first');
  await client.init();
  const records = (await profiles((store) => store.getAll())) as CachedProfile[];
  const profile = records.find(
    (record) =>
      record.origin === location.origin &&
      record.accountId === client.account!.id &&
      record.serverId === client.capabilities?.serverId,
  );
  if (!profile) throw new Error('Cached server identity changed. Sign in again.');
  const refreshToken = await open(
    client.unlocked.masterKey,
    profile.refresh,
    context(client.identity(), 'browser-refresh'),
  );
  client.adoptTokens(
    (await client.transport('/sessions/refresh', { refreshToken })) as Tokens,
  );
  show('offline-state', false);
  await signedIn();
});
on('totp-start', async () => {
  const result = await client.request<{
    secret: string;
    uri: string;
    enrollmentToken: string;
  }>('/factors/totp/start', {});
  totpEnrollment = result.enrollmentToken;
  element('totp-secret').textContent = result.secret;
  element<HTMLAnchorElement>('totp-uri').href = result.uri;
  show('totp-enroll');
  status('Add the secret to your authenticator, then enter its code.');
});
on('totp-enroll', async () => {
  const result = await client.request<{ recoveryCodes: string[] }>(
    '/factors/totp/finish',
    { enrollmentToken: totpEnrollment, code: secret('totp-code') },
  );
  totpEnrollment = undefined;
  element('totp-secret').textContent = '';
  show('totp-enroll', false);
  recoverySheet('MFA recovery codes', result.recoveryCodes.join('\n'));
  await signedIn();
});
on('webauthn-enroll', async () => {
  const result = await client.request<{ options: object; enrollmentToken: string }>(
    '/factors/webauthn/start',
    {},
  );
  const credential = await window.SimpleWebAuthnBrowser.startRegistration({
    optionsJSON: result.options,
  });
  const finished = await client.request<{ recoveryCodes: string[] }>(
    '/factors/webauthn/finish',
    { enrollmentToken: result.enrollmentToken, credential },
  );
  recoverySheet('MFA recovery codes', finished.recoveryCodes.join('\n'));
  await signedIn();
});
on('remove-factor', async () => {
  await client.request('/factors/remove', {
    factorId: value('remove-factor-id'),
    code: secret('remove-factor-code'),
  });
  show('remove-factor', false);
  await signedIn();
});
on('password-change', async () => {
  const password = secret('new-password');
  if (password !== secret('new-password-confirm'))
    throw new Error('Passwords do not match');
  await client.changePassword(password);
  await cache();
  status(
    'Password changed. Other device sessions have been revoked. Your recovery key still works.',
  );
});
on('recover-request', async () => {
  await client.transport('/recovery/request', { identifier: value('recover-id') });
  status(
    'If the account exists, check your email. Recovery also requires your vault recovery key.',
  );
});
on('recover-finish', async () => {
  const password = secret('recover-password');
  if (password !== secret('recover-password-confirm'))
    throw new Error('Passwords do not match');
  await client.recover(
    recoveryMailToken || value('recover-token'),
    secret('recover-key'),
    password,
    secret('recover-mfa') || undefined,
  );
  recoveryMailToken = '';
  show('recover-finish', false);
  status('Password recovered. Sign in with the new password.');
});
on('verify-email', async () => {
  await client.transport('/verify-email', { token: value('verify-token') });
  element<HTMLInputElement>('verify-token').value = '';
  status('Email verified. You can sign in.');
});
on('resend-verification', async () => {
  await client.transport('/verification/resend', { identifier: value('login-id') });
  status('If verification is needed, check your email.');
});
on('profile', async () => {
  await client.request(
    '/profile',
    {
      username: value('profile-username') || null,
      displayName: value('profile-name'),
      ...(value('profile-email') ? { email: value('profile-email') } : {}),
    },
    'PUT',
  );
  status('Profile saved. Email changes require verification at the new address.');
});
on('sessions-refresh', async () => {
  const sessions =
    await client.request<
      { id: string; deviceName: string; revoked: boolean; current: boolean }[]
    >('/sessions');
  element('sessions').replaceChildren();
  for (const session of sessions) {
    const row = document.createElement('li');
    row.textContent =
      session.deviceName +
      (session.current ? ' (this session)' : '') +
      (session.revoked ? ' — revoked' : ' ');
    if (!session.revoked) {
      const revoke = document.createElement('button');
      revoke.textContent = 'Revoke';
      revoke.addEventListener(
        'click',
        run(async () => {
          await client.request('/sessions/revoke', { sessionId: session.id });
          if (session.current) logout();
          else {
            row.textContent = session.deviceName + ' — revoked';
          }
        }),
      );
      row.append(revoke);
    }
    element('sessions').append(row);
  }
  status('Device sessions loaded.');
});
const logout = (): void => {
  client.lock();
  prepared = undefined;
  recoveryText = '';
  totpEnrollment = undefined;
  for (const input of document.querySelectorAll<HTMLInputElement>('input[type=password]'))
    input.value = '';
  element('recovery-material').textContent = '';
  element('totp-secret').textContent = '';
  show('dashboard', false);
  show('mfa', false);
  show('recovery-sheet', false);
  show('offline-state', false);
  show('auth');
  status(
    'Account locked on this page. Encrypted offline unlock data remains on this device.',
  );
};
on('lock', async () => logout());
on('logout', async () => {
  if (client.tokens) {
    const sessions =
      await client.request<{ id: string; current: boolean }[]>('/sessions');
    const current = sessions.find((session) => session.current);
    if (current) await client.request('/sessions/revoke', { sessionId: current.id });
  }
  logout();
});

const params = new URLSearchParams(location.search);
if (params.has('verify'))
  element<HTMLInputElement>('verify-token').value = params.get('verify')!;
if (params.has('recover')) {
  recoveryMailToken = params.get('recover')!;
  show('recover-finish');
}
history.replaceState(null, '', location.pathname);
void client
  .init()
  .then((capabilities) => {
    show('signup-consent', !!capabilities.requireTermsConsent);
    element<HTMLInputElement>('signup-consent-accepted').required =
      !!capabilities.requireTermsConsent;
    show('signup-terms', !!capabilities.hasOperatorTerms);
    status('Ready. Passwords and recovery keys stay on your device.');
  })
  .catch(() =>
    status(
      'The account service is unavailable. Cached accounts can still be unlocked offline.',
    ),
  );
