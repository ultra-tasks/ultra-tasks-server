import {
  AccountClient,
  AccountInfo,
  Tokens,
  httpTransport,
  approveBrowserLogin,
  browserLoginReturnUrl,
  fingerprint,
  type BrowserLoginRequest,
} from '@ultra-tasks/account-crypto';
import {
  AccountBundle,
  VaultContext,
  unlockBundle,
  context,
  open,
  seal,
} from '@ultra-tasks/account-crypto';

declare global {
  interface Window {
    turnstile?: {
      render(
        element: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          'expired-callback': () => void;
          'error-callback': () => void;
        },
      ): string;
      reset(id: string): void;
    };
    SimpleWebAuthnBrowser: {
      startRegistration(input: { optionsJSON: object }): Promise<unknown>;
      startAuthentication(input: { optionsJSON: object }): Promise<unknown>;
    };
  }
}
let turnstileToken = '';
let turnstileRequired = false;
let turnstileWidget = '';
const accountTransport = httpTransport(location.origin);
const client = new AccountClient((path, body, accessToken, method) =>
  accountTransport(
    path,
    path === '/register/start' && turnstileRequired ? { ...body, turnstileToken } : body,
    accessToken,
    method,
  ),
);
const configureTurnstile = (siteKey: string): void => {
  turnstileRequired = true;
  const container = document.getElementById('signup-turnstile')!;
  container.hidden = false;
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.onload = () => {
    if (!window.turnstile) {
      status('Security check could not load. Please refresh and try again.', 'error');
      return;
    }
    turnstileWidget = window.turnstile!.render(container, {
      sitekey: siteKey,
      callback: (value) => {
        turnstileToken = value;
      },
      'expired-callback': () => {
        turnstileToken = '';
      },
      'error-callback': () => {
        turnstileToken = '';
      },
    });
  };
  script.onerror = () =>
    status('Security check could not load. Please refresh and try again.', 'error');
  document.head.appendChild(script);
};
const params = new URLSearchParams(location.search);
const loginBinding = new URLSearchParams(location.hash.slice(1)).get('binding');
const loginReferenceKey = 'ultra-browser-login-v1';
const loginReference = params.has('login')
  ? { ticket: params.get('login'), binding: loginBinding }
  : (JSON.parse(sessionStorage.getItem(loginReferenceKey) || 'null') as {
      ticket: string;
      binding: string;
    } | null);
if (loginReference)
  sessionStorage.setItem(loginReferenceKey, JSON.stringify(loginReference));
history.replaceState(null, '', location.pathname);
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
const status = (message: string, tone = 'info'): void => {
  element('status').textContent = message;
  element('status').dataset.tone = tone;
};
type AuthView = 'login' | 'signup' | 'verify-email' | 'recover-request';
let registrationOpen = false;
const authView = (view: AuthView, focus = true): void => {
  if (view === 'signup' && !registrationOpen) return;
  for (const id of ['login', 'signup', 'verify-email', 'recover-request'])
    show(id, id === view);
  show('auth-back', view !== 'login');
  // Passwords do not follow the user between account flows.
  for (const input of element('auth').querySelectorAll<HTMLInputElement>(
    'input[type=password]',
  ))
    input.value = '';
  if (focus) element(view).querySelector<HTMLInputElement>('input')?.focus();
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-auth-view]'))
  button.addEventListener('click', () => authView(button.dataset.authView as AuthView));
const accountPanel = (id: string, focus = true): void => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-panel]')) {
    const selected = button.dataset.panel === id;
    button.setAttribute('aria-current', selected ? 'page' : 'false');
    show(button.dataset.panel!, selected);
  }
  if (focus) {
    const heading = element(id).querySelector<HTMLElement>('h2');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus();
  }
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-panel]'))
  button.addEventListener('click', () => accountPanel(button.dataset.panel!));
let recoveryText = '';
let prepared: Awaited<ReturnType<AccountClient['prepareRegistration']>> | undefined;
let totpEnrollment: string | undefined;
let recoveryMailToken = '';
let appLogin: BrowserLoginRequest | undefined;
const appLoginInfo = loginReference
  ? (async () => {
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(loginReference.ticket || '') ||
        !/^[A-Za-z0-9_-]{43}$/.test(loginReference.binding || '')
      )
        throw new Error('Invalid app sign-in link. Start again in Ultra Tasks.');
      const request = (await client.transport('/browser-login/info', {
        ticket: loginReference.ticket,
      })) as BrowserLoginRequest;
      if (
        (await fingerprint(request)) !== loginReference.binding ||
        request.expiresAt <= Date.now()
      )
        throw new Error(
          'App sign-in request changed or expired. Start again in Ultra Tasks.',
        );
      return request;
    })()
  : Promise.resolve(undefined);
// The initial service check reports errors; retain the same rejection for sign-in.
void appLoginInfo.catch(() => undefined);
const clearAppLogin = (): void => {
  appLogin = undefined;
  sessionStorage.removeItem(loginReferenceKey);
  show('app-login-context', false);
  show('app-login-approval', false);
};

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
  const request = sessionStorage.getItem(loginReferenceKey)
    ? await appLoginInfo
    : undefined;
  if (request && sessionStorage.getItem(loginReferenceKey)) {
    appLogin = request;
    await cache();
    element('app-login-account').textContent = client.account?.email ?? '';
    show('app-login-approval');
    element('app-login-approve').focus();
    status('Review this request before connecting your app.');
    return;
  }
  show('dashboard');
  accountPanel('account-overview', false);
  element('who').textContent = client.account?.email ?? '';
  await cache();
  const info = await client.request<{ factors: { id: string; kind: string }[] }>('/me');
  element('factors').replaceChildren();
  for (const factor of info.factors) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent =
      factor.kind === 'totp' ? 'Authenticator app' : 'Security key or passkey';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      element<HTMLInputElement>('remove-factor-id').value = factor.id;
      show('remove-factor');
      element('remove-factor-code').focus();
    });
    row.append(label, remove);
    element('factors').append(row);
  }
  element<HTMLInputElement>('profile-username').value = client.account?.username ?? '';
  element<HTMLInputElement>('profile-name').value = client.account?.displayName ?? '';
  await refreshOverview();
  await refreshDevices();
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
      status(error instanceof Error ? error.message : 'Account action failed', 'error');
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
  element('recovery-material').setAttribute('tabindex', '-1');
  element('recovery-material').focus();
};
on('signup', async () => {
  const password = secret('signup-password');
  const confirmation = secret('signup-confirm');
  if (password !== confirmation) throw new Error('Passwords do not match');
  if (turnstileRequired && !turnstileToken)
    throw new Error('Complete the security check before continuing.');
  try {
    prepared = await client.prepareRegistration(
      {
        email: value('signup-email'),
        ...(value('signup-username') ? { username: value('signup-username') } : {}),
        displayName: value('signup-name'),
        termsAccepted: element<HTMLInputElement>('signup-consent-accepted').checked,
      },
      password,
    );
  } finally {
    turnstileToken = '';
    if (turnstileWidget) window.turnstile?.reset(turnstileWidget);
  }
  recoverySheet('vault recovery key', prepared.recoveryKey);
  show('auth', false);
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
  show('auth');
  authView('verify-email');
  status('Check your email to verify the account, then sign in.');
});
on('signup-back', async () => {
  prepared = undefined;
  recoveryText = '';
  element('recovery-material').textContent = '';
  element<HTMLInputElement>('saved-key').checked = false;
  show('recovery-sheet', false);
  show('finish-signup', false);
  show('auth');
  authView('signup');
  status('Recovery key discarded. Update your details to prepare a new key.');
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
    show('auth', false);
    show('mfa');
    show('webauthn-login', !!result.factors?.includes('webauthn'));
    status('Complete two-factor authentication.');
    element<HTMLInputElement>('mfa-code').focus();
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
on('device-approve', async () => {
  const ticket = params.get('device');
  if (!ticket) throw new Error('The device approval link is missing');
  const { options, deviceName } = (await client.transport('/mfa/browser/options', {
    ticket,
  })) as { options: object; deviceName: string };
  element('approval-device-name').textContent = deviceName;
  const credential = await window.SimpleWebAuthnBrowser.startAuthentication({
    optionsJSON: options,
  });
  await client.transport('/mfa/browser/approve', { ticket, credential });
  show('device-approval', false);
  status('Device login approved. Return to the Ultra Tasks app.');
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
  show('auth');
  authView('login');
  status('Password recovered. Sign in with the new password.');
});
on('verify-email', async () => {
  await client.transport('/verify-email', { token: value('verify-token') });
  element<HTMLInputElement>('verify-token').value = '';
  authView('login');
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
const refreshDevices = async (): Promise<void> => {
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
};
on('sessions-refresh', async () => {
  await refreshDevices();
  status('Device sessions loaded.');
});
const refreshOverview = async (): Promise<void> => {
  const overview = await client.request<{
    server: { url: string };
    personal: null | {
      state: string;
      records: number;
      encryptedBytes: number;
      historyBytes: number;
    };
    limits: { encryptedBytes: number; historyBytes: number };
  }>('/overview');
  const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(2) + ' MiB';
  const meter = element<HTMLProgressElement>('storage-meter');
  meter.max = overview.limits.encryptedBytes;
  meter.value = overview.personal?.encryptedBytes ?? 0;
  element('server-address').textContent = overview.server.url;
  element('personal-state').textContent = overview.personal
    ? overview.personal.state
    : 'No data linked yet';
  element('storage-usage').textContent =
    `${overview.personal?.records ?? 0} records · ${mib(overview.personal?.encryptedBytes ?? 0)} of ${mib(overview.limits.encryptedBytes)}`;
  element('history-usage').textContent =
    `${mib(overview.personal?.historyBytes ?? 0)} of ${mib(overview.limits.historyBytes)}`;
};
on('overview-refresh', refreshOverview);
on('delete-account', async () => {
  if (
    value('delete-confirm-email').trim().toLowerCase() !== client.account?.email ||
    !element<HTMLInputElement>('delete-confirm').checked
  )
    throw new Error('Confirm your account email and the deletion warning.');
  const identity = client.identity();
  await client.deleteAccount();
  await profiles(
    (store) => store.delete([location.origin, identity.serverId, identity.accountId]),
    true,
  );
  logout();
  status('Account and personal encrypted server data deleted.');
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
  authView('login', false);
  status(
    'Account locked on this page. Encrypted offline unlock data remains on this device.',
  );
};
on('lock', async () => logout());
on('mfa-cancel', async () => logout());
on('app-login-approve', async () => {
  if (!appLogin) throw new Error('Start sign-in again in Ultra Tasks.');
  const request = appLogin;
  await approveBrowserLogin(client, request);
  const url = browserLoginReturnUrl(request);
  clearAppLogin();
  show('app-login-finished');
  show('app-login-return', !!url);
  if (url) element<HTMLAnchorElement>('app-login-return').href = url;
  status('Sign-in approved. Return to Ultra Tasks.');
  if (url) element<HTMLAnchorElement>('app-login-return').click();
});
on('app-login-deny', async () => {
  if (!appLogin) return;
  const url = browserLoginReturnUrl(appLogin);
  await client.request('/browser-login/deny', { ticket: appLogin.ticket });
  clearAppLogin();
  await signedIn();
  status('App sign-in canceled.');
  if (url) {
    element<HTMLAnchorElement>('app-login-return').href = url;
    element<HTMLAnchorElement>('app-login-return').click();
  }
});
on('app-login-dashboard', async () => {
  show('app-login-finished', false);
  await signedIn();
});
on('logout', async () => {
  if (client.tokens) {
    const sessions =
      await client.request<{ id: string; current: boolean }[]>('/sessions');
    const current = sessions.find((session) => session.current);
    if (current) await client.request('/sessions/revoke', { sessionId: current.id });
  }
  logout();
});

if (params.has('verify')) {
  element<HTMLInputElement>('verify-token').value = params.get('verify')!;
  authView('verify-email', false);
}
if (params.has('recover')) {
  recoveryMailToken = params.get('recover')!;
  show('auth', false);
  show('recover-finish');
}
if (params.has('device')) {
  show('auth', false);
  show('device-approval');
}
void client
  .init()
  .then(async (capabilities) => {
    const siteKey = (capabilities as typeof capabilities & { turnstileSiteKey?: string })
      .turnstileSiteKey;
    if (siteKey) configureTurnstile(siteKey);
    registrationOpen = capabilities.features['registrationOpen'] !== false;
    for (const button of document.querySelectorAll<HTMLElement>('[data-registration]'))
      button.hidden = !registrationOpen;
    show('registration-closed', capabilities.features['registrationOpen'] === false);
    if (
      params.get('view') === 'signup' &&
      !params.has('verify') &&
      !params.has('recover') &&
      !params.has('device')
    )
      authView('signup', false);
    show('signup-consent', !!capabilities.requireTermsConsent);
    element<HTMLInputElement>('signup-consent-accepted').required =
      !!capabilities.requireTermsConsent;
    show('signup-terms', !!capabilities.hasOperatorTerms);
    status('Ready. Passwords and recovery keys stay on your device.');
    if (loginReference) {
      try {
        appLogin = await appLoginInfo;
        if (appLogin) {
          element('app-login-device').textContent = appLogin.deviceName;
          element('app-login-server').textContent = appLogin.serverUrl;
          element('app-login-code').textContent = (await fingerprint(appLogin))
            .slice(0, 8)
            .toUpperCase();
          show('app-login-context');
        }
      } catch (error) {
        sessionStorage.removeItem(loginReferenceKey);
        status(error instanceof Error ? error.message : 'App sign-in expired.', 'error');
      }
    }
  })
  .catch(() =>
    status(
      'The account service is unavailable. Cached accounts can still be unlocked offline.',
    ),
  );
