const encoder = new TextEncoder();
export const utf8 = (value: string): Uint8Array<ArrayBuffer> => encoder.encode(value);
export const encode = (value: ArrayBuffer | Uint8Array): string => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let raw = '';
  for (let i = 0; i < bytes.length; i += 32768)
    raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const decode = (value: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error('Noncanonical base64url');
  return bytes;
};
export const randomKey = (): string => encode(crypto.getRandomValues(new Uint8Array(32)));
export const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error('Unsupported signed value');
    return result;
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const object = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(object)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(object[key]))
      .join(',') +
    '}'
  );
};
export const fingerprint = async (value: unknown): Promise<string> =>
  encode(await crypto.subtle.digest('SHA-256', utf8(canonical(value))));
