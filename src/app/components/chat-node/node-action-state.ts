import { Injectable, signal } from '@angular/core';

/**
 * The action a chat-node card is currently running. Drives the busy labels
 * ("Sending…", "Creating…", "Saving…") and the disabled state of every button
 * of that card.
 */
export type NodeActionKind =
  | 'version'
  | 'branch'
  | 'insert'
  | 'send'
  | 'continue'
  | 'switchCharacters'
  | 'structure'
  | 'prepend'
  | 'image'
  | 'chapterDescriptions';

/**
 * "One action at a time" for a single chat-node card.
 *
 * Every chat-node action costs a round-trip (LLM call or a node-version
 * write) and would otherwise race with the others: two competing sends, a
 * Regenerate landing on top of an in-flight Illustrate, a version write while
 * the editor is committed. The card therefore runs at most ONE action, and
 * every button is disabled while one is running.
 *
 * This lives in a service rather than in `ChatNodeComponent` because the
 * action sequences themselves are extracted into controllers
 * (`IllustrationController`, the send/editor controllers) — they need to raise
 * and clear the busy state of the card they act for. It is provided at the
 * COMPONENT level (see `ChatNodeComponent.providers`), so each card has its
 * own instance and state never leaks between cards.
 *
 * Both flags are written together on purpose: a `pending` kind without
 * `loading` (or the reverse) would render an inconsistent busy label.
 */
@Injectable()
export class NodeActionState {
  /**
   * Writable on purpose: the component and the extracted controllers both
   * drive the same state, and the existing action sequences set/clear it
   * directly. New code should prefer {@link begin} / {@link end}, which keep
   * both flags consistent.
   */
  readonly loading = signal(false);
  /** Which action is running (null when idle). */
  readonly pending = signal<NodeActionKind | null>(null);

  /** True when nothing runs — the guard every action starts with. */
  get idle(): boolean {
    return !this.loading();
  }

  /** Mark `kind` as running. Returns false when the card is already busy. */
  begin(kind: NodeActionKind): boolean {
    if (this.loading()) return false;
    this.loading.set(true);
    this.pending.set(kind);
    return true;
  }

  /** Clear the busy state (always call this in a `finally`). */
  end(): void {
    this.loading.set(false);
    this.pending.set(null);
  }

  /** True while the action of this kind is the one running. */
  isRunning(kind: NodeActionKind): boolean {
    return this.loading() && this.pending() === kind;
  }
}
