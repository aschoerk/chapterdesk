import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZOOM_PERCENTS, ZoomService } from './zoom.service';

describe('ZoomService', () => {
  beforeEach(() => {
    // The app provides page zoom only in the desktop shell — pretend to be it.
    window.electronAPI = { isElectron: true };
    localStorage.removeItem('chat.view.zoom');
    document.documentElement.style.zoom = '';
  });

  afterEach(() => {
    delete window.electronAPI;
    localStorage.removeItem('chat.view.zoom');
    document.documentElement.style.zoom = '';
    vi.restoreAllMocks();
  });

  function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
    return { preventDefault: vi.fn(), ...init } as unknown as KeyboardEvent;
  }

  it('starts at 100 % and leaves the document untouched', () => {
    const zoom = new ZoomService();

    expect(zoom.percent()).toBe(100);
    expect(document.documentElement.style.zoom).toBe('');
  });

  it('steps through the browser zoom levels', () => {
    const zoom = new ZoomService();

    zoom.zoomIn();
    expect(zoom.percent()).toBe(110);
    zoom.zoomIn();
    expect(zoom.percent()).toBe(125);
    zoom.zoomOut();
    expect(zoom.percent()).toBe(110);
    zoom.zoomOut();
    expect(zoom.percent()).toBe(100);
    zoom.zoomOut();
    expect(zoom.percent()).toBe(90);
  });

  it('clamps at the smallest and largest level', () => {
    const zoom = new ZoomService();

    for (let i = 0; i < 50; i++) zoom.zoomOut();
    expect(zoom.percent()).toBe(ZOOM_PERCENTS[0]);

    for (let i = 0; i < 50; i++) zoom.zoomIn();
    expect(zoom.percent()).toBe(ZOOM_PERCENTS[ZOOM_PERCENTS.length - 1]);
  });

  it('applies the zoom to the document root and persists it', () => {
    const zoom = new ZoomService();

    zoom.zoomIn();
    expect(document.documentElement.style.zoom).toBe('1.1');
    expect(localStorage.getItem('chat.view.zoom')).toBe('110');

    // A new instance (next launch) restores the stored level.
    const restored = new ZoomService();
    expect(restored.percent()).toBe(110);
    expect(document.documentElement.style.zoom).toBe('1.1');
  });

  it('resets to 100 % and clears the inline zoom', () => {
    const zoom = new ZoomService();
    zoom.zoomIn();

    zoom.reset();

    expect(zoom.percent()).toBe(100);
    expect(document.documentElement.style.zoom).toBe('');
    expect(localStorage.getItem('chat.view.zoom')).toBe('100');
  });

  describe('onKey', () => {
    it('zooms in with Ctrl/Cmd + "+" and Ctrl/Cmd + "=", including the numpad', () => {
      const zoom = new ZoomService();
      const plus = keyEvent({ key: '+', ctrlKey: true });
      const equal = keyEvent({ key: '=', metaKey: true });
      const numpad = keyEvent({ key: 'Add', code: 'NumpadAdd', ctrlKey: true });

      expect(zoom.onKey(plus)).toBe(true);
      expect(plus.preventDefault).toHaveBeenCalled();
      expect(zoom.percent()).toBe(110);
      expect(zoom.onKey(equal)).toBe(true);
      expect(zoom.percent()).toBe(125);
      expect(zoom.onKey(numpad)).toBe(true);
      expect(zoom.percent()).toBe(150);
    });

    it('zooms out with Ctrl/Cmd + "-", including the numpad', () => {
      const zoom = new ZoomService();
      const minus = keyEvent({ key: '-', ctrlKey: true });
      const underscore = keyEvent({ key: '_', metaKey: true });
      const numpad = keyEvent({ key: 'Subtract', code: 'NumpadSubtract', ctrlKey: true });

      zoom.onKey(minus);
      expect(minus.preventDefault).toHaveBeenCalled();
      expect(zoom.percent()).toBe(90);
      zoom.onKey(underscore);
      expect(zoom.percent()).toBe(80);
      zoom.onKey(numpad);
      expect(zoom.percent()).toBe(75);
    });

    it('resets with Ctrl/Cmd + "0"', () => {
      const zoom = new ZoomService();
      zoom.zoomIn();

      const zero = keyEvent({ key: '0', ctrlKey: true });
      expect(zoom.onKey(zero)).toBe(true);
      expect(zero.preventDefault).toHaveBeenCalled();
      expect(zoom.percent()).toBe(100);
    });

    it('ignores keys without Ctrl/Cmd and combos with Alt', () => {
      const zoom = new ZoomService();

      expect(zoom.onKey(keyEvent({ key: '=' }))).toBe(false);
      expect(zoom.onKey(keyEvent({ key: '-', altKey: true, ctrlKey: true }))).toBe(false);
      expect(zoom.percent()).toBe(100);
    });

    it('leaves the keys to the browser when not running in the desktop shell', () => {
      delete window.electronAPI;
      localStorage.setItem('chat.view.zoom', '150');

      const zoom = new ZoomService();
      const plus = keyEvent({ key: '+', ctrlKey: true });

      // Native browser zoom handles the keys — nothing is consumed or applied.
      expect(zoom.onKey(plus)).toBe(false);
      expect(plus.preventDefault).not.toHaveBeenCalled();
      expect(zoom.percent()).toBe(100);
      expect(document.documentElement.style.zoom).toBe('');
    });
  });
});
