/**
 * Copies text. The async clipboard API needs a secure context and a permission the
 * browser may refuse; the fallback uses a temporary selection and restores focus.
 */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* Try the selection-based fallback below. */
  }
  const previous = document.activeElement as HTMLElement | null;
  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.className = 'visually-hidden';
  document.body.append(area);
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus();
  }
};

/** Selects the text of an element so the person can copy it with the keyboard. */
export const selectText = (target: Element): void => {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(target);
  selection.removeAllRanges();
  selection.addRange(range);
};
