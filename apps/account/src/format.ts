/** Plain formatting helpers for the account page. */

const KIB = 1024;
const MIB = KIB * 1024;

/** `0.17 MiB`, `812 KiB` or `32 MiB`: quiet figures, never raw byte counts. */
export const formatBytes = (bytes: number): string => {
  if (bytes < KIB) return `${bytes} B`;
  if (bytes < MIB / 10) return `${Math.round(bytes / KIB)} KiB`;
  const mib = bytes / MIB;
  return Number.isInteger(mib) ? `${mib} MiB` : `${mib.toFixed(2)} MiB`;
};

/** `d***@example.test`: enough to recognize the address, not enough to disclose it. */
export const maskEmail = (email: string): string => {
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  return `${email[0]}***${email.slice(at)}`;
};

const absolute = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** `3 minutes ago` for the last few days, then a calendar date and time. */
export const formatWhen = (timestamp: number, now = Date.now()): string => {
  const seconds = Math.round((timestamp - now) / 1000);
  const age = Math.abs(seconds);
  if (age < 45) return 'just now';
  if (age < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (age < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (age < 86400 * 7) return relative.format(Math.round(seconds / 86400), 'day');
  return absolute.format(timestamp);
};
/** The exact time, for a tooltip or machine-readable `<time>` element. */
export const formatExact = (timestamp: number): string => absolute.format(timestamp);
