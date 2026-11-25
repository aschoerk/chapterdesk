import { Injectable, signal } from '@angular/core';
import { isElectron } from '../util/electron';

const LS_ZOOM = 'chat.view.zoom';

/**
 * Browser zoom levels (Chromium's step sequence). A level is a percentage of
 * the normal size; 100 is the reset value.
 */
export const ZOOM_PERCENTS = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
] as const;

const MIN_ZOOM = ZOOM_PERCENTS[0];
const MAX_ZOOM = ZOOM_PERCENTS[ZOOM_PERCENTS.length - 1];

/**
 * Browser-like page zoom for the stories view (Ctrl/Cmd `+` / `-` / `0`).
 *
 * The DESKTOP SHELL (Electron, no application menu) has no browser zoom, so
 * the app provides it here: CSS `zoom` on the document root, which in Chromium
 * behaves like page zoom (it shrinks the layout viewport instead of
 * overflowing it) and the level is remembered in localStorage.
 *
 * In a regular BROWSER the native page zoom already handles these keys and
 * cannot be prevented by the page — taking them over too would zoom twice.
 * There `onKey` therefore consumes nothing and the browser does its job.
 */
@Injectable({ providedIn: 'root' })
export class ZoomService {
  /** True in the Electron shell, where the app must provide page zoom itself. */
  private get selfZoom(): boolean {
    return isElectron();
  }

  /** Current zoom in percent (100 = normal size). */
  readonly percent = signal(this.selfZoom ? ZoomService.readStoredPercent() : 100);

  constructor() {
    this.apply(this.percent());
  }

  /** One step up (like the browser's Ctrl/Cmd `+`). */
  zoomIn(): void {
    this.step(1);
  }

  /** One step down (like the browser's Ctrl/Cmd `-`). */
  zoomOut(): void {
    this.step(-1);
  }

  /** Back to 100 % (like the browser's Ctrl/Cmd `0`). */
  reset(): void {
    this.applyPercent(100);
  }

  /**
   * Handle the browser-like zoom keys. Returns true when the event was
   * consumed; the caller must not process it further.
   *
   * Ctrl/Cmd + `+` or `=` zooms in, Ctrl/Cmd + `-` zooms out and
   * Ctrl/Cmd + `0` resets — the same bindings browsers use. Numpad keys are
   * accepted too. Unlike the app's other shortcuts these work while an input
   * is focused, exactly like a browser.
   *
   * In a regular browser nothing is consumed — the native page zoom applies.
   */
  onKey(event: KeyboardEvent): boolean {
    if (!this.selfZoom) return false;

    const ctrl = event.ctrlKey || event.metaKey;
    if (!ctrl || event.altKey) return false;

    if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') {
      event.preventDefault();
      this.zoomIn();
      return true;
    }
    if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') {
      event.preventDefault();
      this.zoomOut();
      return true;
    }
    if (event.key === '0' || event.code === 'Numpad0') {
      event.preventDefault();
      this.reset();
      return true;
    }
    return false;
  }

  private step(direction: 1 | -1): void {
    const current = this.percent();
    const next = direction > 0
      ? ZOOM_PERCENTS.find(level => level > current)
      : [...ZOOM_PERCENTS].reverse().find(level => level < current);
    if (next === undefined) return;
    this.applyPercent(next);
  }

  private applyPercent(percent: number): void {
    this.percent.set(percent);
    try {
      localStorage.setItem(LS_ZOOM, String(percent));
    } catch {
      // Private mode / storage disabled — zoom still works for this session.
    }
    this.apply(percent);
  }

  private apply(percent: number): void {
    if (typeof document === 'undefined') return;
    // 100 % = no inline zoom, so a plain page is untouched.
    document.documentElement.style.zoom = percent === 100 ? '' : String(percent / 100);
  }

  private static readStoredPercent(): number {
    const raw = Number(localStorage.getItem(LS_ZOOM));
    if (!Number.isFinite(raw) || raw <= 0) return 100;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(raw)));
  }
}
