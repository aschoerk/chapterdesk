import { Component, HostListener, inject } from '@angular/core';
import { Router } from '@angular/router';
import { PacedReadService } from '../../core/llm/paced-read.service';
import { I18nService } from '../../core/i18n/i18n.service';

/**
 * Global "paced reading is paused" pill.
 *
 * Pausing a paced read is meant to be USED: the user scrolls around, edits a
 * chapter, opens the settings or browses another story. While the reading view
 * is not mounted, this pill keeps the session visible and offers the two
 * actions that matter — Resume (which navigates back to the chat/reader AND to
 * the exact position the user left, see `PacedReadService.resume()`) and Stop.
 *
 * The chat page and the reader keep their own pause/stop controls while they
 * are open, so the pill only appears when neither is mounted.
 */
@Component({
  selector: 'app-paced-read-indicator',
  standalone: true,
  templateUrl: './paced-read-indicator.component.html',
  styleUrl: './paced-read-indicator.component.css'
})
export class PacedReadIndicatorComponent {
  readonly pacedRead = inject(PacedReadService);
  readonly i18n = inject(I18nService);
  private readonly router = inject(Router);

  /** True when the session is paused AND no reading view is on screen. */
  get visible(): boolean {
    return this.pacedRead.active() && this.pacedRead.paused() && !this.pacedRead.viewLinked();
  }

  /**
   * `P` resumes from anywhere. The chat page and the reader already own that
   * key while they are mounted, so it is only handled here when the user is on
   * another page (otherwise the two handlers would toggle twice).
   */
  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (!this.visible) return;
    if (event.defaultPrevented) return;
    if (this.isTyping(event)) return;
    if (event.key !== 'p' && event.key !== 'P') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (this.onReadingView()) return;
    event.preventDefault();
    this.pacedRead.resume();
  }

  private onReadingView(): boolean {
    const url = this.router.url.split('?')[0];
    return url.startsWith('/chat') || url.startsWith('/read');
  }

  private isTyping(event: KeyboardEvent): boolean {
    const t = event.target as HTMLElement | null;
    return !!t && (
      t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable
    );
  }

  resume(): void {
    this.pacedRead.resume();
  }

  stop(): void {
    this.pacedRead.stop();
  }
}
