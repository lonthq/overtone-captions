// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCaptionsKey } from '../src/core/keyboard';
import { Toast } from '../src/core/toast';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

/** Dispatches a keydown on `target` and returns what isCaptionsKey says about it. */
function check(target: Element, init: KeyboardEventInit): boolean {
  let result = false;
  target.addEventListener('keydown', (event) => (result = isCaptionsKey(event as KeyboardEvent)), { once: true });
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  return result;
}

describe('isCaptionsKey', () => {
  const div = document.createElement('div');

  it('accepts c and C', () => {
    expect(check(div, { key: 'c' })).toBe(true);
    expect(check(div, { key: 'C', shiftKey: true })).toBe(true);
  });

  it('rejects other keys and modifier combinations', () => {
    expect(check(div, { key: 'x' })).toBe(false);
    expect(check(div, { key: 'c', ctrlKey: true })).toBe(false);
    expect(check(div, { key: 'c', metaKey: true })).toBe(false);
    expect(check(div, { key: 'c', altKey: true })).toBe(false);
  });

  it('ignores auto-repeat and IME composition', () => {
    expect(check(div, { key: 'c', repeat: true })).toBe(false);
    expect(check(div, { key: 'c', isComposing: true })).toBe(false);
  });

  it('accepts the C key on non-Latin layouts but not when it types another Latin letter', () => {
    expect(check(div, { key: '\u0441', code: 'KeyC' })).toBe(true);
    expect(check(div, { key: 'j', code: 'KeyC' })).toBe(false);
  });

  it('ignores typing in form fields', () => {
    expect(check(document.createElement('input'), { key: 'c' })).toBe(false);
    expect(check(document.createElement('textarea'), { key: 'c' })).toBe(false);
  });
});

describe('Toast', () => {
  it('appends a status element to its parent', () => {
    const toast = new Toast(document.body);
    expect(toast.el.parentElement).toBe(document.body);
    expect(toast.el.className).toBe('ot-toast');
    expect(toast.el.getAttribute('role')).toBe('status');
  });

  it('shows the text and hides again after the duration', () => {
    vi.useFakeTimers();
    const toast = new Toast(document.body, 1000);
    toast.show('Captions: plain');
    expect(toast.el.textContent).toBe('Captions: plain');
    expect(toast.el.classList.contains('ot-toast-visible')).toBe(true);
    vi.advanceTimersByTime(999);
    expect(toast.el.classList.contains('ot-toast-visible')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(toast.el.classList.contains('ot-toast-visible')).toBe(false);
  });

  it('restarts the timer when shown again', () => {
    vi.useFakeTimers();
    const toast = new Toast(document.body, 1000);
    toast.show('a');
    vi.advanceTimersByTime(800);
    toast.show('b');
    vi.advanceTimersByTime(800);
    expect(toast.el.classList.contains('ot-toast-visible')).toBe(true);
  });

  it('clears the text when it hides', () => {
    vi.useFakeTimers();
    const toast = new Toast(document.body, 1000);
    toast.show('Captions: plain');
    vi.advanceTimersByTime(1000);
    expect(toast.el.textContent).toBe('');
    expect(toast.el.classList.contains('ot-toast-visible')).toBe(false);
  });

  it('cancels the pending hide timer on dispose', () => {
    vi.useFakeTimers();
    const toast = new Toast(document.body, 1000);
    toast.show('x');
    toast.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(toast.el.classList.contains('ot-toast-visible')).toBe(true);
  });

  it('removes its element on dispose', () => {
    const toast = new Toast(document.body);
    toast.dispose();
    expect(toast.el.isConnected).toBe(false);
  });
});
