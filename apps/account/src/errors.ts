/** Turns SDK and server failures into calm, specific sentences for the page. */

/** An error whose message is already written for the user. */
export class UserMessage extends Error {}

/**
 * A security change that needs a sign-in from the last ten minutes. The page explains it and
 * offers to sign in again; `returnNote` is what the sign-in card says on the way back.
 */
export class ReauthNeeded extends UserMessage {
  constructor(
    message: string,
    readonly returnNote: string,
  ) {
    super(message);
  }
}

export type ErrorKind =
  | 'message'
  | 'credentials'
  | 'unverified'
  | 'recent'
  | 'reverify'
  | 'network'
  | 'rate'
  | 'update';
export interface ClassifiedError {
  kind: ErrorKind;
  message: string;
  status?: number;
  /** The server's stable reason, when it sent one (for example `resend_limit`). */
  code?: string;
}

const NETWORK =
  /failed to fetch|networkerror|network request failed|load failed|timed out/i;

/** Sentences for the server's stable error codes. Clients never parse the server's text. */
const SESSION_LIMIT =
  'This account has too many signed-in devices. Sign in on a device you already use and remove an old one in Devices.';
const MAIL_RATE =
  'Too many verification emails were requested for this account. Wait a while before trying again.';
const MAIL_FAILED =
  'The verification email could not be sent. Try again in a moment. If it keeps failing, ask the operator of this server to check its email settings.';
const REVERIFY =
  'This browser has not finished its new-device check. Sign in again here, enter the emailed code if asked, then approve the app request again.';

export const classifyError = (error: unknown): ClassifiedError => {
  if (error instanceof ReauthNeeded) return { kind: 'recent', message: error.message };
  if (error instanceof UserMessage) return { kind: 'message', message: error.message };
  const raw = error instanceof Error ? error.message : '';
  const status = (error as { status?: unknown } | null)?.status;
  const code =
    typeof (error as { code?: unknown } | null)?.code === 'string'
      ? ((error as { code: string }).code as string)
      : undefined;
  if (typeof status === 'number') {
    const result = (kind: ErrorKind, message: string): ClassifiedError => ({
      kind,
      status,
      message,
      ...(code ? { code } : {}),
    });
    if (code === 'session_limit') return result('message', SESSION_LIMIT);
    if (code === 'verification_rate_limited') return result('rate', MAIL_RATE);
    if (code === 'email_delivery_failed') return result('message', MAIL_FAILED);
    if (code === 'device_verification_required') return result('reverify', REVERIFY);
    // The server words these two for the person itself, so its sentence is used as is.
    if (code === 'resend_limit' || code === 'resend_too_soon')
      return result('message', raw);
    if (status === 403 && /verify your email/i.test(raw))
      return result('unverified', 'Verify your email before signing in.');
    if (status === 403 && /sign in again/i.test(raw))
      return result('recent', 'For your security, sign in again before changing this.');
    if (status === 426 || code === 'client_update_required')
      return result(
        'update',
        (/[a-z]{4}/i.test(raw) ? raw : '') ||
          'Update Ultra Tasks to sign in on a new device.',
      );
    // Older servers answer the same situations without a code.
    if (status === 409 && /revoke an old device session/i.test(raw))
      return result('message', SESSION_LIMIT);
    if (status === 503 && /email could not be delivered/i.test(raw))
      return result('message', MAIL_FAILED);
    if (status === 429)
      return result('rate', 'Too many attempts. Wait a few minutes and try again.');
    if (status === 400 && /invalid account request/i.test(raw))
      return result('message', 'Check the details you entered and try again.');
    if (status >= 500 && !/[a-z]{4}/i.test(raw))
      return result(
        'message',
        'The account server had a problem. Try again in a moment.',
      );
    return result('message', raw || 'Something went wrong. Try again.');
  }
  if (error instanceof TypeError && NETWORK.test(raw))
    return {
      kind: 'network',
      message: 'Cannot reach the account service. Check your connection and try again.',
    };
  if (/invalid email, username, or password/i.test(raw))
    return {
      kind: 'credentials',
      message: 'That email or password is not right. Check them and try again.',
    };
  return { kind: 'message', message: raw || 'Something went wrong. Try again.' };
};
