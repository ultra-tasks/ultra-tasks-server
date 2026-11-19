/** Small DOM helpers shared by the account page: lookups, messages and busy buttons. */

export type Tone = 'info' | 'success' | 'warning' | 'error';
export type IconName =
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'eye'
  | 'eye-off'
  | 'copy'
  | 'check';

export const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const result = document.getElementById(id);
  if (!result) throw new Error('Missing account element: ' + id);
  return result as T;
};
export const value = (id: string): string => element<HTMLInputElement>(id).value;
/** Switches a password field back to hidden and resets its show/hide toggle. */
const concealPassword = (input: HTMLInputElement): void => {
  input.type = 'password';
  const toggle = input
    .closest('.password-field')
    ?.querySelector<HTMLButtonElement>('[data-toggle-password]');
  toggle?.setAttribute('aria-pressed', 'false');
  toggle?.querySelector('use')?.setAttribute('href', '#i-eye');
};
/** Empties and re-hides every password field under `root`. */
export const concealPasswords = (root: ParentNode): void => {
  for (const input of root.querySelectorAll<HTMLInputElement>(
    'input[type=password], .password-field input',
  )) {
    input.value = '';
    if (input.closest('.password-field')) concealPassword(input);
  }
};
/** Reads an input and clears it, so secrets never linger in the page. */
export const secret = (id: string): string => {
  const input = element<HTMLInputElement>(id);
  const result = input.value;
  input.value = '';
  if (input.closest('.password-field')) concealPassword(input);
  return result;
};
/** Show/hide buttons keep the same input, so autofill and paste keep working. */
export const setupPasswordToggles = (): void => {
  for (const toggle of document.querySelectorAll<HTMLButtonElement>(
    '[data-toggle-password]',
  )) {
    toggle.setAttribute('aria-controls', toggle.dataset.togglePassword!);
    toggle.addEventListener('click', () => {
      const input = element<HTMLInputElement>(toggle.dataset.togglePassword!);
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(reveal));
      toggle.querySelector('use')?.setAttribute('href', reveal ? '#i-eye-off' : '#i-eye');
    });
  }
};
export const show = (target: string | HTMLElement, visible = true): void => {
  (typeof target === 'string' ? element(target) : target).hidden = !visible;
};
export const isShown = (target: Element): boolean => target.getClientRects().length > 0;
/** Marks fields as invalid (red edge, announced) until the person edits them. */
export const markInvalid = (...ids: string[]): void => {
  for (const id of ids) {
    const input = element<HTMLInputElement>(id);
    input.setAttribute('aria-invalid', 'true');
    input.addEventListener('input', () => input.removeAttribute('aria-invalid'), {
      once: true,
    });
  }
};

const SVG_NS = 'http://www.w3.org/2000/svg';
/** An inline icon that references the sprite in the page (no data: images under the CSP). */
export const icon = (name: IconName): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
};

/** Visually hidden polite announcements for changes that have no visible message. */
let announceTimer: number | undefined;
export const announce = (message: string): void => {
  const live = element('live');
  live.textContent = '';
  window.clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => {
    live.textContent = message;
  }, 60);
};

export interface NoticeAction {
  label: string;
  run: () => void | Promise<void>;
}
const hostOf = (from: Element | null): Element | null => {
  for (let host = from?.closest('[data-notice-host]'); host; ) {
    if (isShown(host) && host.querySelector('[data-notices]')) return host;
    host = host.parentElement?.closest('[data-notice-host]') ?? null;
  }
  return (
    Array.from(document.querySelectorAll('[data-notice-host]')).find(
      (candidate) => isShown(candidate) && candidate.querySelector('[data-notices]'),
    ) ?? null
  );
};
const regionFor = (host: Element, tone: Tone): HTMLElement | null =>
  host.querySelector<HTMLElement>(
    `[data-notices] > [role="${tone === 'error' ? 'alert' : 'status'}"]`,
  );
/** Removes every message from a host (or from the whole page). */
export const clearNotices = (scope: ParentNode = document): void => {
  for (const notice of scope.querySelectorAll('[data-notices] .notice')) notice.remove();
};
/**
 * Shows a message inside the nearest message host of `from`. Errors go to the assertive
 * alert region and everything else to the polite status region, so each is announced
 * where it appears. One message per host: a new one replaces the previous.
 */
export const notify = (
  from: Element | string | null,
  message: string,
  tone: Tone = 'info',
  actions: NoticeAction[] = [],
): HTMLElement | undefined => {
  const host = hostOf(typeof from === 'string' ? element(from) : from);
  const region = host ? regionFor(host, tone) : null;
  if (!host || !region) {
    announce(message);
    return undefined;
  }
  clearNotices(host.querySelector('[data-notices]')!.parentElement ?? host);
  const notice = document.createElement('div');
  notice.className = 'notice';
  notice.dataset.tone = tone;
  const body = document.createElement('div');
  body.className = 'notice-body';
  const text = document.createElement('p');
  text.className = 'notice-text';
  text.textContent = message;
  body.append(text);
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'notice-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'small';
      button.textContent = action.label;
      button.addEventListener('click', () => void action.run());
      row.append(button);
    }
    body.append(row);
  }
  notice.append(icon(tone), body);
  region.append(notice);
  // Keep the message on screen on a narrow phone, where the form can be taller than it.
  notice.scrollIntoView({ block: 'nearest' });
  return notice;
};

let busy = false;
export const isBusy = (): boolean => busy;
type ErrorHandler = (error: unknown, source: Element | null) => void;
let handleError: ErrorHandler = (error, source) =>
  void notify(source, error instanceof Error ? error.message : 'Action failed', 'error');
export const setErrorHandler = (handler: ErrorHandler): void => {
  handleError = handler;
};

const triggerOf = (event: Event): HTMLElement | null => {
  const submitter = (event as SubmitEvent).submitter;
  if (submitter instanceof HTMLElement) return submitter;
  const target = event.currentTarget;
  if (target instanceof HTMLFormElement)
    return target.querySelector<HTMLElement>('button.primary, button[type="submit"]');
  return target instanceof HTMLElement ? target : null;
};
/**
 * Wraps an action for a button or form. Only one runs at a time; the triggering button
 * shows a busy state (it is not disabled, so keyboard focus is kept) and any failure is
 * reported next to the thing that was submitted.
 */
export const run =
  (action: (event: Event) => Promise<void>): ((event: Event) => Promise<void>) =>
  async (event: Event): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const trigger = triggerOf(event);
    const label = trigger?.dataset.busyLabel;
    const original = trigger?.textContent ?? '';
    busy = true;
    document.documentElement.dataset.busy = 'true';
    trigger?.setAttribute('aria-busy', 'true');
    if (trigger && label && !trigger.querySelector('svg')) trigger.textContent = label;
    const source = trigger ?? (event.currentTarget as Element | null);
    clearNotices(
      hostOf(source)?.querySelector('[data-notices]')?.parentElement ?? document,
    );
    try {
      await action(event);
    } catch (error) {
      handleError(error, source);
    } finally {
      busy = false;
      delete document.documentElement.dataset.busy;
      trigger?.removeAttribute('aria-busy');
      // Restore the label unless the action already gave the button a new one.
      if (trigger && label && trigger.textContent === label)
        trigger.textContent = original;
    }
  };
export const on = (id: string, action: () => Promise<void>): void => {
  const target = element(id);
  target.addEventListener(
    target instanceof HTMLFormElement ? 'submit' : 'click',
    run(action),
  );
};
