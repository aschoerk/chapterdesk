import { Injectable, inject } from '@angular/core';
import { LlmLogService, LlmLogEntry } from './llm/llm-log.service';
import { ParsedUsage, parseProviderUsage, sumUsage } from './llm/usage';

/**
 * localStorage key prefix of the PERSISTED per-chat token/cost totals. The
 * sidebar's "Σ" button recomputes a chat's total cost from the LLM log and
 * stores it here so the figure survives reloads:
 *   `chat-client.chat.usage.<chatId>` → JSON { input, output, cached, total, cost }
 */
const LS_USAGE_PREFIX = 'chat-client.chat.usage.';

/** Parse a stored totals record (tolerates missing / corrupt entries). The
 *  stored JSON already holds the NORMALIZED shape ({ input, output, cached,
 *  total, cost }), so we read it directly instead of going through the
 *  provider-name parser. */
export function parseStoredTotals(raw: string | null): ParsedUsage | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    const out: ParsedUsage = {};
    for (const key of ['input', 'output', 'cached', 'total', 'cost'] as const) {
      const v = (o as Record<string, unknown>)[key];
      const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : NaN);
      if (Number.isFinite(n) && n >= 0) out[key] = n;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Reads token usage / cost out of the LLM log, and keeps a PERSISTED
 * per-chat cost total (localStorage) that the sidebar can show.
 *
 * Log entries carry `nodeId` for the node a chat call's output belongs to
 * (the assistant answer node) and `chatId` for every call made in a chat —
 * so both a per-node header and a per-chat sum can be answered from the same
 * reactive data. Entries without usage simply contribute nothing.
 */
@Injectable({ providedIn: 'root' })
export class ChatUsageService {
  private readonly logs = inject(LlmLogService);

  /** Sum of the parsed usage of all log entries for one node (or null). */
  nodeUsage(nodeId: string): ParsedUsage | null {
    if (!nodeId) return null;
    return sumUsage(
      this.logs.entries()
        .filter(e => e.completed && !!e.response && !e.error && e.nodeId === nodeId)
        .map(e => parseProviderUsage(this.usageOf(e)))
    );
  }

  /** Sum of the parsed usage of all log entries for one chat (or null). */
  chatTotals(chatId: string): ParsedUsage | null {
    if (!chatId) return null;
    return sumUsage(
      this.logs.entries()
        .filter(e => e.completed && !!e.response && !e.error && e.chatId === chatId)
        .map(e => parseProviderUsage(this.usageOf(e)))
    );
  }

  /** The persisted (localStorage) totals for a chat, or null. */
  storedTotals(chatId: string): ParsedUsage | null {
    try {
      return parseStoredTotals(localStorage.getItem(LS_USAGE_PREFIX + chatId));
    } catch {
      return null;
    }
  }

  /** Clear the persisted totals of a chat (used when a chat is deleted). */
  clearStored(chatId: string): void {
    try {
      localStorage.removeItem(LS_USAGE_PREFIX + chatId);
    } catch { /* non-fatal */ }
  }

  /**
   * Recompute a chat's total cost (and token sums) from the LLM log, persist
   * it to localStorage and return it. Returns null when the log holds no
   * usage for this chat.
   */
  refreshChat(chatId: string): ParsedUsage | null {
    const totals = this.chatTotals(chatId);
    try {
      if (totals) localStorage.setItem(LS_USAGE_PREFIX + chatId, JSON.stringify(totals));
      else localStorage.removeItem(LS_USAGE_PREFIX + chatId);
    } catch { /* non-fatal */ }
    return totals;
  }

  /** The `response.usage` block of a log entry (OpenAI/Anthropic/Gemini). */
  private usageOf(e: LlmLogEntry): unknown {
    if (e.response == null || typeof e.response !== 'object') return null;
    return (e.response as Record<string, unknown>)['usage']
      ?? (e.response as Record<string, unknown>)['usageMetadata'];
  }
}