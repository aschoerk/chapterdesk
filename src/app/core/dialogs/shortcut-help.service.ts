import { Injectable, signal } from '@angular/core';

/**
 * Open/close state of the in-app keyboard-shortcut reference
 * (`ShortcutHelpComponent`, mounted once in the app root and opened from the
 * top navigation bar). This makes the documented shortcut list discoverable
 * in-app, satisfying UX playbook §7.
 *
 * Kept deliberately simple — it is a pure reference panel, so unlike the
 * promise-based dialog services it holds no data and returns no result.
 */
@Injectable({ providedIn: 'root' })
export class ShortcutHelpService {
  private readonly openFlag = signal(false);

  /** Whether the shortcut reference panel is currently shown. */
  readonly open = this.openFlag.asReadonly();

  /** Open the panel. */
  openDialog(): void {
    this.openFlag.set(true);
  }

  /** Close the panel. */
  close(): void {
    this.openFlag.set(false);
  }
}