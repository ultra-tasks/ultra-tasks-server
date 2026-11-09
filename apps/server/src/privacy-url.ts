const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Where `/privacy.html` should send visitors, when the operator publishes the
 * privacy policy somewhere else (for example on the project website) instead of
 * supplying a file. An empty or missing value means "serve the operator file".
 *
 * Only HTTPS is accepted (plain HTTP only for a loopback address, for local
 * development), and credentials are refused. The sign-up page links here, so a
 * mistyped value must stop the server from starting rather than quietly send
 * people to the wrong place. The message never repeats the value.
 */
export const parsePrivacyPolicyUrl = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('ULTRA_PRIVACY_URL must be an absolute HTTPS URL');
  }
  const secure =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password)
    throw new Error('ULTRA_PRIVACY_URL must be an HTTPS URL without credentials');
  return url.href;
};
