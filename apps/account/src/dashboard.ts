import { formatBytes, formatExact, formatWhen } from './format';
import { element, run, secret, show } from './ui';

/** Pure rendering for the dashboard panels. Actions are passed in as callbacks. */

export interface Overview {
  server: { url: string };
  personal: null | {
    state: string;
    records: number;
    encryptedBytes: number;
    historyBytes: number;
  };
  limits: { encryptedBytes: number; historyBytes: number };
}

/** Friendly storage wording instead of raw state strings; the meter appears only when used. */
export const renderStorage = (overview: Overview): void => {
  element('server-address').textContent = overview.server.url;
  const summary = element('storage-summary');
  const meter = element<HTMLProgressElement>('storage-meter');
  const history = element('history-summary');
  const personal = overview.personal;
  if (!personal) {
    summary.textContent =
      'Nothing is synced yet. Sign in from Ultra Tasks on a device to start syncing.';
    show(meter, false);
    show(history, false);
    return;
  }
  const states: Record<string, string> = {
    migrating: 'Being set up on one of your devices.',
    rotating: 'Updating encryption keys.',
  };
  const used = formatBytes(personal.encryptedBytes);
  const limit = formatBytes(overview.limits.encryptedBytes);
  summary.textContent = `${states[personal.state] ? states[personal.state] + ' ' : ''}${personal.records.toLocaleString()} ${personal.records === 1 ? 'record' : 'records'} · ${used} of ${limit} used. Your tasks are stored encrypted.`;
  meter.max = overview.limits.encryptedBytes;
  meter.value = personal.encryptedBytes;
  show(meter, personal.encryptedBytes > 0);
  history.textContent = `Change history: ${formatBytes(personal.historyBytes)} of ${formatBytes(overview.limits.historyBytes)}.`;
  show(history, personal.historyBytes > 0);
};

export interface Factor {
  id: string;
  kind: string;
}
const factorLabel = (kind: string): string =>
  kind === 'totp' ? 'Authenticator app' : 'Security key or passkey';
export const renderFactors = (
  factors: Factor[],
  onRemove: (factor: Factor) => void,
): void => {
  const list = element('factors');
  list.replaceChildren();
  element('factors-summary').textContent = factors.length
    ? 'On. Signing in asks for a second step as well as your password.'
    : 'Off. Your password is the only thing protecting sign-in.';
  for (const factor of factors) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = factorLabel(factor.kind);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'small';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${factorLabel(factor.kind)}`);
    remove.addEventListener('click', () => onRemove(factor));
    row.append(label, remove);
    list.append(row);
  }
};

export interface DeviceRow {
  /** A trusted device (removing it ends its trust and sessions) or a single session. */
  kind: 'device' | 'session';
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
  current: boolean;
  trusted: boolean;
  revoked: boolean;
}

const time = (timestamp: number): HTMLTimeElement => {
  const result = document.createElement('time');
  result.dateTime = new Date(timestamp).toISOString();
  result.title = formatExact(timestamp);
  result.textContent = formatWhen(timestamp);
  return result;
};
const deviceMeta = (row: DeviceRow): HTMLElement => {
  const meta = document.createElement('p');
  meta.className = 'device-meta';
  const parts: (string | Node)[] = [];
  if (row.revoked) {
    parts.push('Signed out · started ', time(row.createdAt));
  } else {
    parts.push(row.kind === 'device' ? 'Added ' : 'Signed in ', time(row.createdAt));
    if (row.current) parts.push(' · Active now');
    // Last active repeats the first date for a device that was only used once.
    else if (row.lastSeenAt && row.lastSeenAt - row.createdAt > 5 * 60 * 1000)
      parts.push(' · Last active ', time(row.lastSeenAt));
  }
  meta.append(...parts);
  return meta;
};
const badge = (text: string, quiet = false): HTMLElement => {
  const result = document.createElement('span');
  result.className = quiet ? 'badge quiet' : 'badge';
  result.textContent = text;
  return result;
};

/** What removing another device asks for, decided by the page from the account's factors. */
export interface RemovalPolicy {
  /** An authenticator or security key is enrolled: the server wants a current code. */
  needsCode: boolean;
  /** Guidance under the code field, for example for an account with security keys only. */
  hint?: string;
}
export const removalCodeId = (row: Pick<DeviceRow, 'id'>): string =>
  `remove-code-${row.id}`;

/**
 * Opens the inline confirmation for one row. Removing another trusted device may need a
 * second-factor code (the same pattern as removing a second factor), so it is a small form;
 * removing this browser or a plain session needs only the confirmation.
 */
const confirmRemoval = async (
  row: DeviceRow,
  item: HTMLElement,
  actions: HTMLElement,
  opener: HTMLElement,
  remove: (row: DeviceRow, code?: string) => Promise<void>,
  policy: () => Promise<RemovalPolicy>,
): Promise<void> => {
  actions.hidden = true;
  const { needsCode, hint } =
    row.kind === 'device' && !row.current
      ? await policy()
      : { needsCode: false, hint: '' };
  const confirm = document.createElement('form');
  confirm.className = 'device-confirm';
  confirm.setAttribute('aria-label', `Confirm removing ${row.name}`);
  const text = document.createElement('p');
  text.append(
    'Remove ',
    Object.assign(document.createElement('strong'), { textContent: row.name }),
    '? ',
  );
  text.append(
    (row.current ? 'You will be signed out of this browser' : 'It will be signed out') +
      (row.trusted ? ' and asked for a new-device check next time' : '') +
      (row.current ? '.' : '. Tasks already on it stay there.'),
  );
  confirm.append(text);
  if (needsCode) {
    const id = removalCodeId(row);
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = 'Authenticator or recovery code';
    const input = document.createElement('input');
    input.id = id;
    input.type = 'password';
    input.autocomplete = 'one-time-code';
    input.autocapitalize = 'none';
    input.spellcheck = false;
    input.required = true;
    input.minLength = 6;
    input.maxLength = 64;
    field.append(label, input);
    if (hint) {
      const help = document.createElement('p');
      help.id = `${id}-help`;
      help.className = 'field-help';
      help.textContent = hint;
      input.setAttribute('aria-describedby', help.id);
      field.append(help);
    }
    confirm.append(field);
  }
  const buttons = document.createElement('div');
  buttons.className = 'actions';
  const yes = document.createElement('button');
  yes.type = 'submit';
  yes.className = 'danger small';
  yes.textContent = 'Remove device';
  yes.dataset.busyLabel = 'Removing…';
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'small';
  no.textContent = 'Cancel';
  no.addEventListener('click', () => {
    confirm.remove();
    actions.hidden = false;
    opener.focus();
  });
  buttons.append(yes, no);
  confirm.append(buttons);
  confirm.addEventListener(
    'submit',
    run(async () => remove(row, needsCode ? secret(removalCodeId(row)) : undefined)),
  );
  item.append(confirm);
  // With a code to type, the field takes focus. Otherwise the safe choice does, so a
  // stray Enter cannot remove the device.
  (needsCode ? element(removalCodeId(row)) : no).focus();
};

export const renderDevices = (
  rows: DeviceRow[],
  remove: (row: DeviceRow, code?: string) => Promise<void>,
  policy: () => Promise<RemovalPolicy>,
): void => {
  const active = rows
    .filter((row) => !row.revoked)
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt),
    );
  const ended = rows
    .filter((row) => row.revoked)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10);
  const list = element('sessions');
  list.replaceChildren();
  for (const row of active) {
    const item = document.createElement('li');
    item.dataset.deviceId = row.id;
    const main = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'device-name';
    name.append(row.name);
    if (row.current) name.append(badge('This device'));
    if (row.trusted) name.append(badge('Trusted', true));
    main.append(name, deviceMeta(row));
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'small';
    button.textContent = 'Remove device';
    button.setAttribute('aria-label', `Remove ${row.name}`);
    button.dataset.busyLabel = 'Removing…';
    actions.append(button);
    item.append(main, actions);
    button.addEventListener(
      'click',
      () => void confirmRemoval(row, item, actions, button, remove, policy),
    );
    list.append(item);
  }
  show('sessions-empty', active.filter((row) => !row.current).length === 0);
  const endedList = element('sessions-ended-list');
  endedList.replaceChildren();
  for (const row of ended) {
    const item = document.createElement('li');
    const main = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'device-name';
    name.textContent = row.name;
    main.append(name, deviceMeta(row));
    item.append(main);
    endedList.append(item);
  }
  show('sessions-ended', ended.length > 0);
  element('sessions-ended-summary').textContent = `Signed-out devices (${ended.length})`;
};

export interface CalendarFeed {
  id: string;
  label: string;
  privacy: string;
}
export const renderFeeds = (
  feeds: CalendarFeed[],
  hooks: {
    rotate: (feed: CalendarFeed) => (event: Event) => Promise<void>;
    stop: (feed: CalendarFeed, row: HTMLElement) => (event: Event) => Promise<void>;
  },
): void => {
  const list = element('calendar-feed-list');
  list.replaceChildren();
  element('calendar-feed-url').replaceChildren();
  if (!feeds.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-line';
    empty.textContent =
      'No calendars published. You can publish selected tasks from the Ultra Tasks app.';
    list.append(empty);
    return;
  }
  for (const feed of feeds) {
    const row = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'item-main';
    const label = document.createElement('strong');
    label.textContent = feed.label;
    const meta = document.createElement('p');
    meta.className = 'item-meta';
    meta.textContent =
      feed.privacy === 'busy' ? 'Busy times only' : 'Task titles and times';
    main.append(label, meta);
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const rotate = document.createElement('button');
    rotate.type = 'button';
    rotate.className = 'small';
    rotate.textContent = 'Rotate URL';
    rotate.setAttribute('aria-label', `Rotate URL for ${feed.label}`);
    rotate.addEventListener('click', hooks.rotate(feed));
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'small';
    stop.textContent = 'Stop publishing';
    stop.setAttribute('aria-label', `Stop publishing ${feed.label}`);
    stop.addEventListener('click', hooks.stop(feed, row));
    actions.append(rotate, stop);
    row.append(main, actions);
    list.append(row);
  }
};
