import {
  AccountClient,
  httpTransport,
  approveBrowserLogin,
  browserLoginReturnUrl,
  fingerprint,
  unlockBundle,
  context,
  open,
  seal,
  type AccountInfo,
  type BrowserLoginRequest,
  type DeviceInfo,
  type DeviceVerification,
  type Tokens,
  type VaultContext,
} from '@ultra-tasks/account-crypto';
import { copyText, selectText } from './clipboard';
import {
  renderDevices,
  renderFactors,
  renderFeeds,
  removalCodeId,
  renderStorage,
  type CalendarFeed,
  type DeviceRow,
  type Factor,
  type Overview,
  type RemovalPolicy,
} from './dashboard';
import {
  clearDeviceToken,
  deviceLabel,
  loadDeviceToken,
  saveDeviceToken,
} from './device';
import { classifyError, ReauthNeeded, UserMessage } from './errors';
import { maskEmail } from './format';
import {
  deleteProfile,
  hasProfileFor,
  listProfiles,
  putProfile,
  type CachedProfile,
} from './profiles';
import {
  announce,
  clearNotices,
  concealPasswords,
  element,
  icon,
  isBusy,
  markInvalid,
  notify,
  on,
  run,
  secret,
  setErrorHandler,
  setupPasswordToggles,
  show,
  value,
  type Tone,
} from './ui';

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

const SUFFIX = 'Ultra Tasks account';
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
  const container = element('signup-turnstile');
  container.hidden = false;
  const failed = (): void =>
    void notify(
      'signup',
      'The security check could not load. Refresh the page and try again.',
      'error',
    );
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.onload = () => {
    if (!window.turnstile) return failed();
    turnstileWidget = window.turnstile.render(container, {
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
  script.onerror = failed;
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

// Screens ---------------------------------------------------------------------------
type Screen =
  | 'auth'
  | 'mfa'
  | 'device-verify'
  | 'recovery'
  | 'offline'
  | 'recover-finish'
  | 'device-approval'
  | 'app-approval'
  | 'app-finished'
  | 'dashboard';
const SCREENS: Record<Screen, { id: string; title: string; heading?: string }> = {
  auth: { id: 'auth', title: 'Sign in' },
  mfa: { id: 'mfa', title: 'Two-factor authentication', heading: 'mfa-title' },
  'device-verify': {
    id: 'device-verify',
    title: 'Verify this device',
    heading: 'device-verify-title',
  },
  recovery: {
    id: 'recovery-sheet',
    title: 'Save your recovery key',
    heading: 'recovery-title',
  },
  offline: {
    id: 'offline-state',
    title: 'Cached account unlocked',
    heading: 'offline-title',
  },
  'recover-finish': {
    id: 'recover-finish',
    title: 'Set a new password',
    heading: 'recover-finish-title',
  },
  'device-approval': {
    id: 'device-approval',
    title: 'Approve a device sign-in',
    heading: 'device-approval-title',
  },
  'app-approval': {
    id: 'app-login-approval',
    title: 'Connect your app',
    heading: 'app-login-approval-title',
  },
  'app-finished': {
    id: 'app-login-finished',
    title: 'Return to Ultra Tasks',
    heading: 'app-login-finished-title',
  },
  dashboard: { id: 'dashboard', title: 'Account', heading: 'dash-title' },
};
let currentScreen: Screen = 'auth';
let appLogin: BrowserLoginRequest | undefined;
const setTitle = (title: string): void => {
  document.title = `${title} – ${SUFFIX}`;
};
const focusHeading = (id: string): void => {
  const heading = element(id);
  heading.setAttribute('tabindex', '-1');
  heading.focus();
};
const showScreen = (screen: Screen, focus = true): void => {
  currentScreen = screen;
  for (const [name, def] of Object.entries(SCREENS)) show(def.id, name === screen);
  // The request banner stays above every step of an app sign-in until it is approved.
  show(
    'app-login-context',
    !!appLogin && ['auth', 'mfa', 'device-verify'].includes(screen),
  );
  setTitle(SCREENS[screen].title);
  const heading = SCREENS[screen].heading;
  if (focus && heading) focusHeading(heading);
};

type AuthView = 'login' | 'signup' | 'verify-email' | 'recover-request';
const AUTH_TITLES: Record<AuthView, string> = {
  login: 'Sign in',
  signup: 'Create account',
  'verify-email': 'Verify your email',
  'recover-request': 'Reset your password',
};
let registrationOpen = false;
const authView = (view: AuthView, focus = true): void => {
  if (view === 'signup' && !registrationOpen) return;
  showScreen('auth', false);
  for (const id of ['login', 'signup', 'verify-email', 'recover-request'])
    show(id, id === view);
  clearNotices(element('auth'));
  // Passwords do not follow the user between account flows.
  concealPasswords(element('auth'));
  setTitle(AUTH_TITLES[view]);
  if (focus)
    element(view).querySelector<HTMLInputElement>('input:not([type=hidden])')?.focus();
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-auth-view]'))
  button.addEventListener('click', () => {
    const view = button.dataset.authView as AuthView;
    if (view === 'verify-email') {
      show('verify-steps', false);
      element('verify-lede').textContent = 'Enter the 8-digit code we emailed you.';
    }
    const known = value('login-id').trim();
    authView(view);
    if (view === 'verify-email' && known) {
      element<HTMLInputElement>('verify-identifier').value = known;
      element('verify-token').focus();
    }
    if (view === 'recover-request' && known)
      element<HTMLInputElement>('recover-id').value = known;
  });
setupPasswordToggles();

const PANELS: Record<string, string> = {
  'panel-account': 'Account',
  'panel-security': 'Security',
  'panel-devices': 'Devices',
};
const accountPanel = (id: string, focus = true): void => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-panel]')) {
    const selected = button.dataset.panel === id;
    button.setAttribute('aria-current', selected ? 'page' : 'false');
    show(button.dataset.panel!, selected);
  }
  setTitle(PANELS[id]);
  if (focus) {
    focusHeading(element(id).querySelector('h2')!.id);
    // Opening a panel refreshes what it shows; a failure leaves the last data in place.
    if (id === 'panel-devices') void refreshDevices().catch(sessionLost);
    if (id === 'panel-account') void refreshOverview();
    if (id === 'panel-security') void refreshMe().catch(sessionLost);
  }
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-panel]'))
  button.addEventListener('click', () => accountPanel(button.dataset.panel!));

// Shared state ----------------------------------------------------------------------
let recoveryText = '';
let prepared: Awaited<ReturnType<AccountClient['prepareRegistration']>> | undefined;
let signupEmail = '';
let totpEnrollment: string | undefined;
let recoveryMailToken = '';
let lastIdentifier = '';
let me: Me | undefined;
interface Me {
  account: AccountInfo;
  factors: Factor[];
  settings?: { newDeviceEmailVerification?: boolean };
}
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
const requestCode = async (request: BrowserLoginRequest): Promise<string> =>
  (await fingerprint(request)).slice(0, 8).toUpperCase();
const clearAppLogin = (): void => {
  appLogin = undefined;
  sessionStorage.removeItem(loginReferenceKey);
  show('app-login-context', false);
};

// Encrypted offline-unlock cache ----------------------------------------------------
const refreshOfflineOption = async (): Promise<void> =>
  show('offline-option', await hasProfileFor(location.origin));
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
  await putProfile(profile);
  void refreshOfflineOption();
};
client.onTokensChanged = cache;

// Leaving a session -----------------------------------------------------------------
const leaveSession = (message?: { text: string; tone?: Tone }): void => {
  client.lock();
  prepared = undefined;
  recoveryText = '';
  totpEnrollment = undefined;
  me = undefined;
  window.clearInterval(resendTimer);
  concealPasswords(document);
  // Codes and confirmations typed on this page never outlive the session.
  for (const id of [
    'mfa-code',
    'device-code',
    'totp-code',
    'remove-factor-code',
    'new-device-code',
    'new-email',
    'delete-confirm-email',
  ])
    element<HTMLInputElement>(id).value = '';
  for (const id of [
    'recovery-material',
    'totp-secret',
    'who',
    'account-email',
    'account-id',
    'server-address',
    'offline-email',
  ])
    element(id).textContent = '';
  for (const id of ['sessions', 'sessions-ended-list', 'calendar-feed-list', 'factors'])
    element(id).replaceChildren();
  for (const id of ['email-change', 'new-device-confirm', 'totp-enroll', 'remove-factor'])
    show(id, false);
  authView('login', false);
  if (message) notify('login', message.text, message.tone ?? 'info');
  focusHeading('login-title');
};
/** A background request failed because the session ended elsewhere. */
const sessionLost = (error: unknown): void => {
  if ((error as { status?: unknown } | null)?.status === 401)
    leaveSession({ text: 'Your session ended. Sign in again to continue.' });
};
const signInAgain = async (text = 'Sign in again to continue.'): Promise<void> => {
  try {
    const sessions =
      await client.request<{ id: string; current: boolean }[]>('/sessions');
    const current = sessions.find((session) => session.current);
    if (current) await client.request('/sessions/revoke', { sessionId: current.id });
  } catch {
    /* The session may already be gone; either way the keys leave this page. */
  }
  leaveSession({ text });
};

setErrorHandler((error, source) => {
  const info = classifyError(error);
  if (error instanceof ReauthNeeded)
    notify(source, error.message, 'error', [
      { label: 'Sign in again', run: () => signInAgain(error.returnNote) },
    ]);
  else if (info.kind === 'recent')
    notify(source, info.message, 'error', [
      { label: 'Sign in again', run: () => signInAgain() },
    ]);
  else if (info.kind === 'reverify')
    // An approval needs a session that passed the new-device check: sign in again here, which
    // runs it, and the app request is still waiting afterwards.
    notify(source, info.message, 'error', [
      {
        label: 'Sign in again',
        run: () =>
          signInAgain(
            'Sign in again to finish the new-device check, then approve the app request again.',
          ),
      },
    ]);
  else if (info.kind === 'update')
    notify(
      source,
      `${info.message} Reload this page to update, then try again.`,
      'error',
      [{ label: 'Reload page', run: () => location.reload() }],
    );
  else notify(source, info.message, 'error');
});

// Sign-in ---------------------------------------------------------------------------
/**
 * Keeps the device token a password sign-in produced: the one the server newly issued or,
 * when it issued none, the valid one this browser presented. With neither, an existing
 * stored token is left alone.
 */
const rememberDevice = async (): Promise<void> => {
  await saveDeviceToken(
    location.origin,
    [lastIdentifier, client.account?.email ?? ''],
    client.deviceToken,
  );
};
const signedIn = async (): Promise<void> => {
  const request = sessionStorage.getItem(loginReferenceKey)
    ? await appLoginInfo
    : undefined;
  if (request && sessionStorage.getItem(loginReferenceKey)) {
    appLogin = request;
    await cache();
    element('app-login-account').textContent = client.account?.email ?? '';
    element('app-login-approval-device').textContent = request.deviceName;
    element('app-login-approval-code').textContent = await requestCode(request);
    showScreen('app-approval');
    return;
  }
  const account = client.account!;
  element('who').textContent = account.email;
  element('account-email').textContent = account.email;
  element('account-id').textContent = account.id;
  element('copy-account-id-status').textContent = '';
  element('storage-summary').textContent = 'Loading…';
  show('storage-meter', false);
  show('history-summary', false);
  show('email-change', false);
  element('change-email').setAttribute('aria-expanded', 'false');
  showScreen('dashboard', false);
  accountPanel('panel-account', false);
  focusHeading('dash-title');
  announce(`Signed in as ${account.email}.`);
  await cache();
  const loaded = await Promise.allSettled([
    refreshMe(),
    refreshOverview(),
    refreshCalendars(),
    refreshDevices(),
  ]);
  const failed = loaded.find((result) => result.status === 'rejected');
  if (failed) {
    sessionLost((failed as PromiseRejectedResult).reason);
    if (currentScreen === 'dashboard')
      notify(
        'panel-account',
        'Some account details could not be loaded. Open another section and come back to try again.',
        'warning',
      );
  }
};

const loginFailure = (error: unknown): never => {
  const info = classifyError(error);
  show('login-verify-help', info.kind === 'unverified');
  if (info.kind === 'credentials' || info.status === 401) {
    element('login-password').focus();
    markInvalid('login-password');
    throw new UserMessage(
      'That email or password is not right. Check them and try again.',
    );
  }
  if (info.kind === 'network') {
    // The account service cannot be reached: surface the cached-account option.
    element<HTMLDetailsElement>('login-advanced').open = true;
    throw new UserMessage(
      `${info.message} If you have signed in on this device before, you can unlock your cached account offline under Advanced.`,
    );
  }
  throw error;
};
on('login', async () => {
  show('login-verify-help', false);
  const identifier = value('login-id').trim();
  const password = secret('login-password');
  const deviceName = value('device-name').trim() || deviceLabel();
  lastIdentifier = identifier;
  const deviceToken = await loadDeviceToken(location.origin, identifier);
  let result;
  try {
    result = await client.login(
      identifier,
      password,
      deviceName,
      deviceToken ? { deviceToken } : {},
    );
  } catch (error) {
    return loginFailure(error);
  }
  if (result.mfaToken) {
    showScreen('mfa');
    show('webauthn-login', !!result.factors?.includes('webauthn'));
    announce('Two-factor authentication is required.');
    element<HTMLInputElement>('mfa-code').focus();
  } else if (result.verification) startDeviceVerification(result.verification);
  else {
    await rememberDevice();
    await signedIn();
  }
});
on('mfa', async () => {
  try {
    await client.completeMfa(secret('mfa-code'));
  } catch (error) {
    if (classifyError(error).status === 401) {
      element('mfa-code').focus();
      markInvalid('mfa-code');
      throw new UserMessage(
        'That code did not work. Check it and try again, or use a recovery code.',
      );
    }
    throw error;
  }
  await rememberDevice();
  await signedIn();
});
const securityKeyFailure = (error: unknown): never => {
  if (
    error instanceof DOMException &&
    ['NotAllowedError', 'AbortError'].includes(error.name)
  )
    throw new UserMessage(
      'The security key request was cancelled or timed out. Try again, or use a code instead.',
    );
  throw error;
};
on('webauthn-login', async () => {
  try {
    const response = await client.webauthnLoginOptions();
    const credential = await window.SimpleWebAuthnBrowser.startAuthentication({
      optionsJSON: response.options,
    });
    await client.completeWebauthn(response.credentialToken, credential);
  } catch (error) {
    return securityKeyFailure(error);
  }
  await rememberDevice();
  await signedIn();
});
on('mfa-cancel', async () => leaveSession());

// New-device email verification -----------------------------------------------------
let resendTimer: number | undefined;
const startCooldown = (seconds: number, resendsLeft?: number): void => {
  const button = element<HTMLButtonElement>('device-resend');
  window.clearInterval(resendTimer);
  const exhausted = resendsLeft !== undefined && resendsLeft <= 0;
  const until = Date.now() + seconds * 1000;
  const tick = (): void => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (exhausted) {
      button.disabled = true;
      button.textContent = 'No more codes for this sign-in';
    } else if (left > 0) {
      button.disabled = true;
      button.textContent = `Send a new code in ${left}s`;
    } else {
      window.clearInterval(resendTimer);
      button.disabled = false;
      button.textContent = 'Send a new code';
    }
  };
  tick();
  if (!exhausted && seconds > 0) resendTimer = window.setInterval(tick, 1000);
};
const showVerification = (verification: DeviceVerification): void => {
  element('device-verify-hint').textContent = verification.emailHint;
  element('device-code-help').textContent =
    `The code expires in ${Math.max(1, Math.round(verification.expiresIn / 60))} minutes.`;
  startCooldown(verification.resendAfter, verification.resendsLeft);
};
function startDeviceVerification(verification: DeviceVerification): void {
  showScreen('device-verify');
  element<HTMLInputElement>('device-code').value = '';
  showVerification(verification);
  announce(`We sent an 8-digit code to ${verification.emailHint}.`);
  element('device-code').focus();
}
const verificationFailure = (error: unknown): never => {
  const info = classifyError(error);
  if (info.status === 401)
    throw new UserMessage(
      'That code is not right or has expired. Check the newest email, or send a new code. If this keeps happening, go back and sign in again.',
    );
  throw error;
};
on('device-verify', async () => {
  const code = secret('device-code');
  try {
    await client.completeDeviceVerification(code);
  } catch (error) {
    element('device-code').focus();
    if (classifyError(error).status === 401) markInvalid('device-code');
    return verificationFailure(error);
  }
  window.clearInterval(resendTimer);
  await rememberDevice();
  await signedIn();
});
on('device-resend', async () => {
  let next: DeviceVerification;
  try {
    next = await client.resendDeviceVerification();
  } catch (error) {
    const info = classifyError(error);
    if (info.code === 'resend_limit') startCooldown(0, 0);
    // The SDK ends the pending sign-in when its challenge is gone (401: expired, or locked
    // after too many wrong codes) or its mail could not be sent (503). There is nothing left
    // to type a code into, so say so on the sign-in card.
    if (info.status === 401) {
      leaveSession({
        text: 'That sign-in expired or was locked after too many wrong codes. Sign in again to get a new code.',
      });
      return;
    }
    if (info.code === 'email_delivery_failed') {
      leaveSession({ text: info.message, tone: 'error' });
      return;
    }
    throw error;
  }
  showVerification(next);
  element<HTMLInputElement>('device-code').value = '';
  element('device-code').focus();
  notify(
    'device-verify',
    `We sent a new code to ${next.emailHint}. Use the newest email.`,
    'success',
  );
});
on('device-cancel', async () => {
  window.clearInterval(resendTimer);
  leaveSession();
});

// Create account --------------------------------------------------------------------
const recoverySheet = (kind: 'vault' | 'mfa', material: string): void => {
  const label = kind === 'vault' ? 'vault recovery key' : 'MFA recovery codes';
  recoveryText = `Ultra Tasks ${label}\nServer: ${location.origin}\nAccount: ${client.account?.email ?? signupEmail}\n\n${material}\n\nKeep this material private. Losing your password and vault recovery key, without an unlocked device, means losing access to encrypted data. MFA recovery codes recover login only and cannot decrypt data.`;
  element('recovery-material').textContent = material;
  element('recovery-title').textContent =
    kind === 'vault' ? 'Save your recovery key' : 'Save your recovery codes';
  element('recovery-material').setAttribute(
    'aria-label',
    kind === 'vault' ? 'Recovery key' : 'Recovery codes',
  );
  for (const part of document.querySelectorAll<HTMLElement>('[data-recovery]'))
    part.hidden = part.dataset.recovery !== kind;
  show('recovery-steps', kind === 'vault');
  show('finish-signup', kind === 'vault');
  show('finish-codes', kind === 'mfa');
  element<HTMLInputElement>('saved-key').checked = false;
  element<HTMLInputElement>('saved-codes').checked = false;
  clearNotices(element('recovery-sheet'));
  showScreen('recovery');
  SCREENS.recovery.title = element('recovery-title').textContent ?? '';
  setTitle(SCREENS.recovery.title);
};
const clearRecoveryMaterial = (): void => {
  recoveryText = '';
  element('recovery-material').textContent = '';
  element<HTMLInputElement>('saved-key').checked = false;
  element<HTMLInputElement>('saved-codes').checked = false;
};
on('signup', async () => {
  const password = secret('signup-password');
  const confirmation = secret('signup-confirm');
  if (password !== confirmation) {
    element('signup-password').focus();
    markInvalid('signup-password', 'signup-confirm');
    throw new UserMessage('The passwords do not match. Enter them again.');
  }
  if (turnstileRequired && !turnstileToken)
    throw new UserMessage('Complete the security check before continuing.');
  signupEmail = value('signup-email').trim();
  try {
    prepared = await client.prepareRegistration(
      {
        email: signupEmail,
        termsAccepted: element<HTMLInputElement>('signup-consent-accepted').checked,
      },
      password,
    );
  } finally {
    turnstileToken = '';
    if (turnstileWidget) window.turnstile?.reset(turnstileWidget);
  }
  recoverySheet('vault', prepared.recoveryKey);
});
on('finish-signup', async () => {
  if (!prepared || !element<HTMLInputElement>('saved-key').checked)
    throw new UserMessage('Confirm that you saved the recovery key.');
  await client.register(prepared);
  prepared = undefined;
  clearRecoveryMaterial();
  element('calendar-feed-list').replaceChildren();
  element('calendar-feed-url').replaceChildren();
  show('calendar-publications', false);
  show('verify-steps');
  authView('verify-email', false);
  element<HTMLInputElement>('verify-identifier').value = signupEmail;
  element('verify-lede').textContent =
    `We sent an 8-digit code to ${maskEmail(signupEmail)}. Enter it below to finish creating your account.`;
  notify('verify-email', 'Account created. Check your email for the code.', 'success');
  element('verify-token').focus();
});
on('signup-back', async () => {
  prepared = undefined;
  clearRecoveryMaterial();
  authView('signup', false);
  notify(
    'signup',
    'Recovery key discarded. Update your details to prepare a new key.',
    'info',
  );
  focusHeading('signup-title');
});
element('copy-recovery').addEventListener(
  'click',
  () =>
    void copyText(recoveryText).then((copied) =>
      notify(
        'recovery-sheet',
        copied
          ? 'Copied. Store it in your password manager.'
          : 'Copying was blocked. Select the text above and copy it yourself.',
        copied ? 'success' : 'warning',
      ),
    ),
);
element('download-recovery').addEventListener('click', () => {
  const url = URL.createObjectURL(
    new Blob([recoveryText], { type: 'text/plain;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download =
    element('finish-codes').hidden === false
      ? 'ultra-tasks-recovery-codes.txt'
      : 'ultra-tasks-recovery.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify('recovery-sheet', 'Saved. Keep the file private.', 'info');
});
element('print-recovery').addEventListener('click', () => window.print());
on('finish-codes', async () => {
  if (!element<HTMLInputElement>('saved-codes').checked)
    throw new UserMessage('Confirm that you saved the recovery codes.');
  clearRecoveryMaterial();
  showScreen('dashboard', false);
  accountPanel('panel-security', true);
  notify(
    'panel-security',
    'Two-factor authentication is on. Your other devices were signed out.',
    'success',
  );
  await refreshDevices();
});

// Verify email and recover ----------------------------------------------------------
on('verify-email', async () => {
  const entered = value('verify-token').trim();
  const identifier = value('verify-identifier').trim();
  try {
    if (/^\d{8}$/.test(entered)) {
      if (!identifier) throw new UserMessage('Enter your email address.');
      await client.transport('/verify-email', { identifier, code: entered });
    } else await client.transport('/verify-email', { token: entered });
  } catch (error) {
    if (classifyError(error).status === 401) {
      markInvalid('verify-token');
      throw new UserMessage(
        'That code is not right or has expired. Check the newest email, or send a new code.',
      );
    }
    throw error;
  }
  element<HTMLInputElement>('verify-token').value = '';
  authView('login', false);
  if (identifier) element<HTMLInputElement>('login-id').value = identifier;
  notify('login', 'Email verified. Sign in to continue.', 'success');
  element(identifier ? 'login-password' : 'login-id').focus();
});
on('verify-resend', async () => {
  const identifier = value('verify-identifier').trim();
  if (!identifier) throw new UserMessage('Enter your email address.');
  await client.transport('/verification/resend', { identifier });
  notify(
    'verify-email',
    'If verification is needed, check your email for a new code. If registration expired, start again.',
    'info',
  );
});
on('resend-verification', async () => {
  await client.transport('/verification/resend', {
    identifier: value('login-id').trim(),
  });
  notify(
    'login',
    'If verification is needed, check your email for a new code or link.',
    'info',
  );
});
on('recover-request', async () => {
  await client.transport('/recovery/request', { identifier: value('recover-id').trim() });
  notify(
    'recover-request',
    'If the account exists, check your email for a recovery link. You will also need your vault recovery key.',
    'success',
  );
});
on('recover-finish', async () => {
  const password = secret('recover-password');
  if (password !== secret('recover-password-confirm')) {
    element('recover-password').focus();
    markInvalid('recover-password', 'recover-password-confirm');
    throw new UserMessage('The passwords do not match. Enter them again.');
  }
  await client.recover(
    recoveryMailToken || value('recover-token'),
    secret('recover-key'),
    password,
    secret('recover-mfa') || undefined,
  );
  recoveryMailToken = '';
  element<HTMLInputElement>('recover-token').value = '';
  authView('login', false);
  notify('login', 'Password recovered. Sign in with your new password.', 'success');
  element('login-id').focus();
});

// Offline unlock --------------------------------------------------------------------
on('offline-unlock', async () => {
  const name = value('login-id').trim().toLowerCase();
  const password = secret('login-password');
  if (!name || !password)
    throw new UserMessage('Enter your email and password above, then unlock offline.');
  const records = await listProfiles();
  const profile = records.find(
    (record) =>
      record.origin === location.origin &&
      (record.account.email === name || record.account.username === name),
  );
  if (!profile) throw new UserMessage('No cached account for that email on this device.');
  const identity: VaultContext = {
    serverId: profile.serverId,
    accountId: profile.accountId,
  };
  try {
    client.unlocked = await unlockBundle(profile.bundle, identity, { password });
  } catch {
    throw new UserMessage('That password does not unlock the cached account.');
  }
  client.account = profile.account;
  client.bundle = profile.bundle;
  element('offline-email').textContent = profile.account.email;
  showScreen('offline');
  announce('Cached account unlocked offline.');
});
on('resume-session', async () => {
  if (!client.account || !client.unlocked)
    throw new UserMessage('Unlock the cached account first.');
  await client.init();
  const records = await listProfiles();
  const profile = records.find(
    (record) =>
      record.origin === location.origin &&
      record.accountId === client.account!.id &&
      record.serverId === client.capabilities?.serverId,
  );
  if (!profile)
    throw new UserMessage('The cached server identity changed. Sign in again.');
  const refreshToken = await open(
    client.unlocked.masterKey,
    profile.refresh,
    context(client.identity(), 'browser-refresh'),
  );
  client.adoptTokens(
    (await client.transport('/sessions/refresh', { refreshToken })) as Tokens,
  );
  await signedIn();
});
on('offline-lock', async () => leaveSession());

// Account panel ---------------------------------------------------------------------
const refreshOverview = async (): Promise<void> => {
  try {
    renderStorage(await client.request<Overview>('/overview'));
  } catch (error) {
    element('server-address').textContent = location.origin;
    element('storage-summary').textContent = 'Storage details are unavailable right now.';
    sessionLost(error);
  }
};
element('copy-account-id').addEventListener('click', () => {
  const status = element('copy-account-id-status');
  void copyText(element('account-id').textContent ?? '').then((copied) => {
    if (!copied) selectText(element('account-id'));
    status.textContent = copied
      ? 'Copied to clipboard.'
      : 'Copying was blocked. The ID is selected: press Ctrl+C or Cmd+C.';
    window.setTimeout(() => (status.textContent = ''), 5000);
  });
});
const toggleEmailForm = (open: boolean): void => {
  show('email-change', open);
  element('change-email').setAttribute('aria-expanded', String(open));
  if (open) element('new-email').focus();
  else element('change-email').focus();
};
element('change-email').addEventListener('click', () =>
  toggleEmailForm(!!element('email-change').hidden),
);
element('change-email-cancel').addEventListener('click', () => toggleEmailForm(false));
on('email-change', async () => {
  const email = value('new-email').trim().toLowerCase();
  if (email === client.account?.email)
    throw new UserMessage('That is already your email address.');
  await client.request('/profile', { email }, 'PUT');
  element<HTMLInputElement>('new-email').value = '';
  show('email-change', false);
  element('change-email').setAttribute('aria-expanded', 'false');
  element('change-email').focus();
  notify(
    'panel-account',
    `We sent a verification link to ${email}. Your email stays ${client.account?.email} until you open it.`,
    'success',
  );
});

const refreshCalendars = async (): Promise<void> => {
  try {
    const { feeds } = await client.request<{ feeds: CalendarFeed[] }>('/calendar-feeds');
    show('calendar-publications');
    renderFeeds(feeds, {
      rotate: (feed) =>
        run(async () => {
          const result = await client.request<{ url: string }>(
            `/calendar-feeds/${feed.id}/rotate`,
            {},
          );
          showFeedUrl(feed.label, result.url);
        }),
      stop: (feed, row) =>
        run(async () => {
          await client.request(`/calendar-feeds/${feed.id}`, undefined, 'DELETE');
          row.remove();
          element('calendar-feed-url').replaceChildren();
          if (!element('calendar-feed-list').children.length) await refreshCalendars();
          notify(
            'panel-account',
            'Calendar publication stopped. Previously downloaded copies may remain in calendar apps.',
            'success',
          );
        }),
    });
  } catch {
    show('calendar-publications', false);
  }
};
const showFeedUrl = (label: string, url: string): void => {
  const box = document.createElement('div');
  box.className = 'notice';
  box.dataset.tone = 'success';
  const body = document.createElement('div');
  body.className = 'notice-body';
  const text = document.createElement('p');
  text.className = 'notice-text';
  text.textContent = `New subscription URL for ${label} (shown only now):`;
  const code = document.createElement('code');
  code.className = 'url-value';
  code.textContent = url;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'small';
  copy.textContent = 'Copy URL';
  copy.addEventListener(
    'click',
    () =>
      void copyText(url).then((copied) => {
        if (!copied) selectText(code);
        copy.textContent = copied ? 'Copied' : 'Select and copy';
      }),
  );
  const actions = document.createElement('div');
  actions.className = 'notice-actions';
  actions.append(copy);
  body.append(text, code, actions);
  box.append(icon('success'), body);
  element('calendar-feed-url').replaceChildren(box);
};

// Security panel --------------------------------------------------------------------
const refreshMe = async (): Promise<void> => {
  me = await client.request<Me>('/me');
  renderFactors(me.factors, (factor) => {
    element<HTMLInputElement>('remove-factor-id').value = factor.id;
    show('remove-factor');
    element('remove-factor-code').focus();
  });
  element('totp-start').textContent = me.factors.some((factor) => factor.kind === 'totp')
    ? 'Replace authenticator'
    : 'Set up authenticator';
  // The control exists only on servers that report the setting and offer the feature.
  const setting = me.settings?.newDeviceEmailVerification;
  const offered =
    typeof setting === 'boolean' &&
    client.capabilities?.features['newDeviceEmailVerification'] === true;
  show('new-device-row', offered);
  if (!offered) hideNewDeviceForm();
  if (typeof setting === 'boolean') {
    element('new-device-toggle').setAttribute('aria-checked', String(setting));
    show('new-device-2fa-note', me.factors.length > 0);
  }
};
const hideNewDeviceForm = (): void => {
  show('new-device-confirm', false);
  element<HTMLInputElement>('new-device-code').value = '';
};
/**
 * Turning the check off is the risky direction: warn first, and ask for a second-factor
 * code when one is enrolled. Turning it on needs neither.
 */
const askToTurnOff = (): void => {
  const secondFactor = (me?.factors.length ?? 0) > 0;
  element('new-device-confirm-text').textContent =
    'Turn off new-device email verification? Anyone who knows your password will be able to sign in on a new device without an email code.';
  show('new-device-code-field', secondFactor);
  show('new-device-confirm');
  element(secondFactor ? 'new-device-code' : 'new-device-cancel').focus();
};
const applyNewDevice = async (enabled: boolean, code?: string): Promise<void> => {
  const result = await client.setNewDeviceEmailVerification(enabled, code);
  const now = result?.newDeviceEmailVerification ?? enabled;
  me = { ...me!, settings: { newDeviceEmailVerification: now } };
  element('new-device-toggle').setAttribute('aria-checked', String(now));
  hideNewDeviceForm();
  element('new-device-toggle').focus();
  notify(
    'panel-security',
    now
      ? 'New-device email verification is on. We will email a code when you sign in on a device we do not recognize.'
      : 'New-device email verification is off.',
    now ? 'success' : 'warning',
  );
};
element('new-device-toggle').addEventListener('click', (event) => {
  if (isBusy()) return;
  const enable = element('new-device-toggle').getAttribute('aria-checked') !== 'true';
  if (!enable) return askToTurnOff();
  void run(() => applyNewDevice(true))(event);
});
on('new-device-confirm', async () => {
  const code = secret('new-device-code').trim();
  if ((me?.factors.length ?? 0) > 0 && !code)
    throw new UserMessage('Enter an authenticator or recovery code to confirm.');
  try {
    await applyNewDevice(false, code || undefined);
  } catch (error) {
    if (classifyError(error).status === 401) {
      element('new-device-code').focus();
      markInvalid('new-device-code');
      throw new UserMessage('That code did not work. Check it and try again.');
    }
    throw error;
  }
});
element('new-device-cancel').addEventListener('click', () => {
  hideNewDeviceForm();
  element('new-device-toggle').focus();
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
  element('totp-code').focus();
});
element('totp-cancel').addEventListener('click', () => {
  totpEnrollment = undefined;
  element('totp-secret').textContent = '';
  show('totp-enroll', false);
  element('totp-start').focus();
});
on('totp-enroll', async () => {
  let result: { recoveryCodes: string[] };
  try {
    result = await client.request<{ recoveryCodes: string[] }>('/factors/totp/finish', {
      enrollmentToken: totpEnrollment,
      code: secret('totp-code'),
    });
  } catch (error) {
    if (classifyError(error).status === 401) {
      element('totp-code').focus();
      markInvalid('totp-code');
      throw new UserMessage(
        'That code did not work. Check the time on your device and try the next code.',
      );
    }
    throw error;
  }
  totpEnrollment = undefined;
  element('totp-secret').textContent = '';
  show('totp-enroll', false);
  recoverySheet('mfa', result.recoveryCodes.join('\n'));
});
on('webauthn-enroll', async () => {
  let finished: { recoveryCodes: string[] };
  try {
    const result = await client.request<{ options: object; enrollmentToken: string }>(
      '/factors/webauthn/start',
      {},
    );
    const credential = await window.SimpleWebAuthnBrowser.startRegistration({
      optionsJSON: result.options,
    });
    finished = await client.request<{ recoveryCodes: string[] }>(
      '/factors/webauthn/finish',
      { enrollmentToken: result.enrollmentToken, credential },
    );
  } catch (error) {
    return securityKeyFailure(error);
  }
  recoverySheet('mfa', finished.recoveryCodes.join('\n'));
});
element('remove-factor-cancel').addEventListener('click', () => {
  element<HTMLInputElement>('remove-factor-code').value = '';
  show('remove-factor', false);
});
on('remove-factor', async () => {
  try {
    await client.request('/factors/remove', {
      factorId: value('remove-factor-id'),
      code: secret('remove-factor-code'),
    });
  } catch (error) {
    if (classifyError(error).status === 401) {
      element('remove-factor-code').focus();
      markInvalid('remove-factor-code');
      throw new UserMessage('That code did not work. Check it and try again.');
    }
    throw error;
  }
  show('remove-factor', false);
  await refreshMe();
  await refreshDevices();
  notify(
    'panel-security',
    'Second factor removed. Your other devices were signed out.',
    'success',
  );
});
on('password-change', async () => {
  const password = secret('new-password');
  if (password !== secret('new-password-confirm')) {
    element('new-password').focus();
    markInvalid('new-password', 'new-password-confirm');
    throw new UserMessage('The passwords do not match. Enter them again.');
  }
  await client.changePassword(password);
  await cache();
  element<HTMLDetailsElement>('password-details').open = false;
  await refreshDevices();
  notify(
    'panel-security',
    'Password changed. Your other devices were signed out. Your recovery key still works.',
    'success',
  );
});
on('delete-account', async () => {
  if (
    value('delete-confirm-email').trim().toLowerCase() !== client.account?.email ||
    !element<HTMLInputElement>('delete-confirm').checked
  )
    throw new UserMessage('Confirm your account email and the deletion warning.');
  const identity = client.identity();
  const email = client.account.email;
  await client.deleteAccount();
  await deleteProfile(location.origin, identity.serverId, identity.accountId);
  await clearDeviceToken(location.origin, [lastIdentifier, email]);
  element<HTMLInputElement>('delete-confirm-email').value = '';
  element<HTMLInputElement>('delete-confirm').checked = false;
  void refreshOfflineOption();
  leaveSession({
    text: 'Your account and its personal encrypted server data were deleted.',
    tone: 'success',
  });
});

// Devices ---------------------------------------------------------------------------
interface SessionRow {
  id: string;
  deviceName: string;
  createdAt: number;
  revoked: boolean;
  current: boolean;
  deviceId?: string | null;
  lastSeenAt?: number | null;
  trusted?: boolean;
}
/**
 * What removing another trusted device asks for: a current code while an authenticator or
 * security key is enrolled. The server accepts only an authenticator or recovery code here.
 */
const removalPolicy = async (): Promise<RemovalPolicy> => {
  if (!me) await refreshMe().catch(sessionLost);
  const factors = me?.factors ?? [];
  const keysOnly =
    factors.length > 0 && factors.every((factor) => factor.kind === 'webauthn');
  return {
    needsCode: factors.length > 0,
    ...(keysOnly ? { hint: 'Use a recovery code to remove another device.' } : {}),
  };
};
const removeDevice = async (row: DeviceRow, code?: string): Promise<void> => {
  // Another trusted device is a security change: a recent sign-in and, with a second factor
  // enrolled, a current code. This browser's own device and plain sessions need neither.
  const another = row.kind === 'device' && !row.current;
  const codeNeeded = another && (me?.factors.length ?? 0) > 0;
  if (codeNeeded && !code?.trim())
    throw new UserMessage(
      'Enter an authenticator or recovery code to remove this device.',
    );
  try {
    if (row.kind === 'device') await client.revokeDevice(row.id, code);
    else await client.request('/sessions/revoke', { sessionId: row.id });
  } catch (error) {
    const info = classifyError(error);
    if (another && info.kind === 'recent')
      throw new ReauthNeeded(
        'For your security, sign in again before removing another device.',
        'Sign in again to remove devices.',
      );
    if (another && info.status === 401) {
      // With a code in play a 401 means the code was wrong; the session stays. With none,
      // there was nothing to get wrong, so the session itself has ended.
      if (!codeNeeded) return sessionLost(error);
      element<HTMLInputElement>(removalCodeId(row)).focus();
      markInvalid(removalCodeId(row));
      throw new UserMessage('That code did not work.');
    }
    throw error;
  }
  if (row.current) {
    await clearDeviceToken(location.origin, [
      lastIdentifier,
      client.account?.email ?? '',
    ]);
    leaveSession({
      text: 'This browser was removed from your devices. Sign in to continue.',
    });
    return;
  }
  await refreshDevices();
  notify('panel-devices', `${row.name} was removed.`, 'success');
};
const refreshDevices = async (): Promise<void> => {
  const sessions = await client.request<SessionRow[]>('/sessions');
  let devices: DeviceInfo[] = [];
  if (client.capabilities?.features['trustedDevices'] === true)
    try {
      devices = await client.devices();
    } catch {
      /* Fall back to listing sessions only. */
    }
  const trusted = new Set(devices.map((device) => device.id));
  show('devices-trusted-note', client.capabilities?.features['trustedDevices'] === true);
  const rows: DeviceRow[] = [
    ...devices.map(
      (device): DeviceRow => ({
        kind: 'device',
        id: device.id,
        name: device.label,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        current: device.current,
        trusted: true,
        revoked: false,
      }),
    ),
    ...sessions
      // Sessions of a listed device are shown once, as that device.
      .filter((session) => !(session.deviceId && trusted.has(session.deviceId)))
      .map(
        (session): DeviceRow => ({
          kind: 'session',
          id: session.id,
          name: session.deviceName,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt ?? undefined,
          current: session.current,
          trusted: session.trusted === true,
          revoked: session.revoked,
        }),
      ),
  ];
  renderDevices(rows, removeDevice, removalPolicy);
};
on('sessions-refresh', async () => {
  await refreshDevices();
  announce('Devices refreshed.');
});

// Lock and sign out -----------------------------------------------------------------
on('lock', async () =>
  leaveSession({ text: 'Locked. Your encryption keys were cleared from this page.' }),
);
on('logout', async () => {
  let ended = true;
  if (client.tokens)
    try {
      const sessions =
        await client.request<{ id: string; current: boolean }[]>('/sessions');
      const current = sessions.find((session) => session.current);
      if (current) await client.request('/sessions/revoke', { sessionId: current.id });
    } catch {
      ended = false;
    }
  // The keys always leave this page; say so plainly if the server could not be told.
  leaveSession(
    ended
      ? {
          text: 'Signed out. Encrypted offline unlock data stays on this device until you clear this site’s data.',
        }
      : {
          text: 'Signed out of this page, but the server could not be reached to end the session. Remove this browser from Devices when you are online.',
          tone: 'warning',
        },
  );
});

// Approving a sign-in started in the Ultra Tasks app --------------------------------
on('app-login-approve', async () => {
  if (!appLogin) throw new UserMessage('Start sign-in again in Ultra Tasks.');
  const request = appLogin;
  await approveBrowserLogin(client, request);
  const url = browserLoginReturnUrl(request);
  clearAppLogin();
  showScreen('app-finished');
  show('app-login-return', !!url);
  if (url) {
    element<HTMLAnchorElement>('app-login-return').href = url;
    element<HTMLAnchorElement>('app-login-return').click();
  }
  announce('Sign-in approved. Return to Ultra Tasks.');
});
on('app-login-deny', async () => {
  if (!appLogin) return;
  const url = browserLoginReturnUrl(appLogin);
  await client.request('/browser-login/deny', { ticket: appLogin.ticket });
  clearAppLogin();
  await signedIn();
  notify('panel-account', 'App sign-in canceled.', 'info');
  if (url) {
    element<HTMLAnchorElement>('app-login-return').href = url;
    element<HTMLAnchorElement>('app-login-return').click();
  }
});
on('app-login-dashboard', async () => {
  await signedIn();
});

// Approving a security-key sign-in for a device -------------------------------------
on('device-approve', async () => {
  const ticket = params.get('device');
  if (!ticket) throw new UserMessage('The device approval link is missing.');
  try {
    const { options, deviceName } = (await client.transport('/mfa/browser/options', {
      ticket,
    })) as { options: object; deviceName: string };
    element('approval-device-name').textContent = deviceName;
    const credential = await window.SimpleWebAuthnBrowser.startAuthentication({
      optionsJSON: options,
    });
    await client.transport('/mfa/browser/approve', { ticket, credential });
  } catch (error) {
    return securityKeyFailure(error);
  }
  show('device-approve', false);
  notify(
    'device-approval',
    'Device sign-in approved. Return to the Ultra Tasks app.',
    'success',
  );
});

// Start-up --------------------------------------------------------------------------
element<HTMLInputElement>('device-name').value = deviceLabel();
void refreshOfflineOption();
if (params.has('verify')) {
  element<HTMLInputElement>('verify-token').value = params.get('verify')!;
  authView('verify-email', false);
}
if (params.has('recover')) {
  recoveryMailToken = params.get('recover')!;
  showScreen('recover-finish', false);
}
if (params.has('device')) showScreen('device-approval', false);
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
    if (loginReference) {
      try {
        appLogin = await appLoginInfo;
        if (appLogin) {
          element('app-login-device').textContent = appLogin.deviceName;
          element('app-login-server').textContent = appLogin.serverUrl;
          element('app-login-code').textContent = await requestCode(appLogin);
          showScreen(currentScreen, false);
        }
      } catch (error) {
        sessionStorage.removeItem(loginReferenceKey);
        notify(
          'login',
          error instanceof Error ? error.message : 'App sign-in expired.',
          'error',
        );
      }
    }
  })
  .catch(() => {
    element<HTMLDetailsElement>('login-advanced').open = true;
    notify(
      'login',
      'The account service is unavailable right now. If you have signed in on this device before, you can unlock your cached account offline under Advanced.',
      'warning',
    );
  })
  .finally(() => {
    document.body.dataset.ready = 'true';
  });
