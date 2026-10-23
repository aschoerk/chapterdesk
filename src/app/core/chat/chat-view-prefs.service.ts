import { Injectable, signal } from '@angular/core';

const LS_SCROLL = 'chat.scrollByChatId';

/**
 * View preferences + scroll memory for the chat page — pure localStorage-
 * backed UI state, fully decoupled from the chat/node tree. Extracted from
 * `ChatService` so that state owns its own persistence and can be tested /
 * reused independently. `ChatService` exposes the SAME signal instances and
 * delegates the setters, so all existing consumers keep working unchanged.
 */
@Injectable({ providedIn: 'root' })
export class ChatViewPrefsService {
  private loadViewPref(key: string, fallback: boolean): boolean {
    const raw = localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  }

  readonly followStreaming = signal(this.loadViewPref('chat.view.followStreaming', true));
  readonly followThinking = signal(this.loadViewPref('chat.view.followThinking', true));
  readonly alwaysOpenAtLeaf = signal(this.loadViewPref('chat.view.alwaysOpenAtLeaf', false));

  setFollowStreaming(on: boolean) {
    this.followStreaming.set(on);
    localStorage.setItem('chat.view.followStreaming', on ? '1' : '0');
  }

  setFollowThinking(on: boolean) {
    this.followThinking.set(on);
    localStorage.setItem('chat.view.followThinking', on ? '1' : '0');
  }

  setAlwaysOpenAtLeaf(on: boolean) {
    this.alwaysOpenAtLeaf.set(on);
    localStorage.setItem('chat.view.alwaysOpenAtLeaf', on ? '1' : '0');
  }

  /** After the LLM finishes, keep revealing leftover text at streamSpeed. */
  readonly paceAfterComplete = signal(this.loadViewPref('chat.view.paceAfterComplete', true));

  setPaceAfterComplete(on: boolean) {
    this.paceAfterComplete.set(on);
    localStorage.setItem('chat.view.paceAfterComplete', on ? '1' : '0');
  }

  readonly streamSpeedUnit = signal<'char' | 'word'>(
    this.loadViewPrefStr('chat.view.streamSpeedUnit', 'char') as 'char' | 'word'
  );
  /** Units per second. 0 = instant (current behavior). */
  readonly streamSpeed = signal(this.loadViewPrefNum('chat.view.streamSpeed', 0));

  private loadViewPrefStr(key: string, fallback: string): string {
    return localStorage.getItem(key) || fallback;
  }

  private loadViewPrefNum(key: string, fallback: number): number {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) ? n : fallback;
  }

  private static readonly CHARS_PER_WORD = 5;
  private static readonly CHAR_MAX = 160;
  private static readonly WORD_MAX = 30;

  setStreamSpeedUnit(unit: 'char' | 'word') {
    const from = this.streamSpeedUnit();
    if (unit === from) return;

    const rate = this.streamSpeed();
    let next = rate;

    if (rate > 0) {
      next = from === 'char'
        ? rate / ChatViewPrefsService.CHARS_PER_WORD
        : rate * ChatViewPrefsService.CHARS_PER_WORD;
    }

    const max = unit === 'word' ? ChatViewPrefsService.WORD_MAX : ChatViewPrefsService.CHAR_MAX;
    const step = unit === 'word' ? 1 : 5;
    next = rate === 0 ? 0 : Math.min(max, Math.max(step, Math.round(next / step) * step));

    this.streamSpeedUnit.set(unit);
    localStorage.setItem('chat.view.streamSpeedUnit', unit);
    this.setStreamSpeed(next);
  }

  setStreamSpeed(rate: number) {
    const n = Math.max(0, rate);
    this.streamSpeed.set(n);
    localStorage.setItem('chat.view.streamSpeed', String(n));
  }

  // --------------------------------------------------------------- scroll

  private readScrollMap(): Record<string, number> {
    try {
      const raw = localStorage.getItem(LS_SCROLL);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  getSavedScroll(chatId: string | null | undefined): number | null {
    if (!chatId) return null;
    const value = this.readScrollMap()[chatId];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  saveScroll(chatId: string | null | undefined, top: number): void {
    if (!chatId) return;
    const map = this.readScrollMap();
    map[chatId] = Math.max(0, Math.round(top));
    localStorage.setItem(LS_SCROLL, JSON.stringify(map));
  }

  scrollToNode(nodeId: string) {
    const el = document.querySelector(`[data-node-id="${nodeId}"]`) as HTMLElement | null;
    if (!el) return;

    el.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
      inline: 'nearest'
    });
  }
}