import { Injectable, computed, inject, signal } from '@angular/core';
import { BundleService } from '../bundle.service';
import { ChatService } from '../chat.service';
import { ProjectService } from '../project.service';
import { DEMO_BUNDLE } from './demo-bundle';

/** Name used by the bundled demo project (the idempotency guard). */
export const DEMO_PROJECT_NAME = 'ChapterDesk Demo';

function normName(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase();
}

/**
 * Loads the built-in demo workspace (see `demo-bundle.ts`) exactly once.
 *
 * It demonstrates structure, reading and editing without needing an LLM
 * provider/model. Idempotency is based on the ACTUAL presence of the
 * "ChapterDesk Demo" project (not on a localStorage marker), so no stale
 * browser-storage state is ever left behind: if the user deletes the demo
 * workspace the demo becomes loadable again.
 */
@Injectable({ providedIn: 'root' })
export class DemoDataService {
  private readonly bundleService = inject(BundleService);
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);

  /** True while an import is running (for UI spinners). */
  readonly loading = signal(false);

  /**
   * True when the demo workspace is present. Reactive: it mirrors the loaded
   * project list, so it flips back to false as soon as the demo project is
   * deleted (→ the demo can be loaded again, no stale flag blocks it).
   */
  readonly loaded = computed(() => this.hasDemoProject());

  private hasDemoProject(): boolean {
    for (const p of this.projectService.projects()) {
      if (normName(p.name) === normName(DEMO_PROJECT_NAME)) return true;
    }
    return false;
  }

  /** True when the demo workspace is present. */
  isLoaded(): boolean {
    return this.hasDemoProject();
  }

  /**
   * Import the demo bundle (idempotent). Returns the demo chat that should be
   * opened, or null when the import was skipped (demo already present).
   */
  async loadDemoData(): Promise<string | null> {
    await this.bundleService.loadAll();
    if (this.hasDemoProject()) {
      return null;
    }
    this.loading.set(true);
    try {
      await this.bundleService.importBundle(DEMO_BUNDLE, 'create');
      await this.bundleService.loadAll();
      return this.firstDemoChatId();
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Auto-load the demo data when the workspace is completely empty (a fresh
   * install). Returns the first-run demo chat id, or null when nothing was
   * imported (workspace already had data or demo was already loaded).
   */
  async ensureDemoData(): Promise<string | null> {
    await this.bundleService.loadAll();
    const empty =
      this.chatService.chats().length === 0 &&
      this.projectService.projects().length === 0;
    if (!empty) return null;
    return this.loadDemoData();
  }

  /** The most instructive demo chat (the tour) — opened by default. */
  private firstDemoChatId(): string | null {
    const chats = this.chatService.chats();
    const tour = chats.find(c => c.title === 'Reader & Editor Tour');
    const story = chats.find(c => c.title === 'The Lantern Keeper');
    return (tour ?? story ?? chats[0])?.id ?? null;
  }

  /** Select the first demo chat so the user lands on content immediately. */
  async openFirstDemoChat(): Promise<void> {
    const id = this.firstDemoChatId();
    if (!id) return;
    await this.chatService.selectChat(id);
  }
}