import { beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChatUsageService } from './chat-usage.service';
import { LlmLogEntry, LlmLogService } from './llm/llm-log.service';

function usageEntry(usage: unknown): LlmLogEntry {
  return {
    seq: 0, ts: 0, iso: '', summary: '',
    kind: 'chat', modelId: 'm', provider: 'p',
    nodeId: 'n1', chatId: 'c1',
    response: { usage }, completed: true
  } as LlmLogEntry;
}

function failedEntry(): LlmLogEntry {
  return {
    seq: 1, ts: 0, iso: '', summary: '',
    kind: 'chat', modelId: 'm', provider: 'p',
    nodeId: 'n1', chatId: 'c1',
    completed: true, error: { status: 500, text: 'boom' }
  } as LlmLogEntry;
}

describe('ChatUsageService', () => {
  let service: ChatUsageService;
  let setEntries: (value: LlmLogEntry[]) => void;

  beforeEach(() => {
    localStorage.clear();
    const logs = signal<LlmLogEntry[]>([]);
    setEntries = (value) => logs.set(value);
    TestBed.configureTestingModule({
      providers: [
        ChatUsageService,
        { provide: LlmLogService, useValue: { entries: logs } }
      ]
    });
    service = TestBed.inject(ChatUsageService);
  });

  it('sums the node usage from the log entries attributed to that node', () => {
    setEntries([
      usageEntry({ prompt_tokens: 12, completion_tokens: 30, total_cost: 0.0004 }),
      usageEntry({ prompt_tokens: 8, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } }),
      { ...usageEntry({ prompt_tokens: 100 }), nodeId: 'other' }
    ]);
    const u = service.nodeUsage('n1');
    expect(u?.input).toBe(20);
    expect(u?.output).toBe(35);
    expect(u?.cached).toBe(3);
    expect(u?.cost).toBeCloseTo(0.0004, 10);
  });

  it('ignores failed entries and entries without usage', () => {
    setEntries([
      failedEntry(),
      usageEntry({})
    ]);
    expect(service.nodeUsage('n1')).toBeNull();
  });

  it('returns null for an unknown node id', () => {
    setEntries([usageEntry({ prompt_tokens: 12 })]);
    expect(service.nodeUsage('missing')).toBeNull();
  });

  it('sums a whole chat across every entry (incl. image calls)', () => {
    setEntries([
      usageEntry({ prompt_tokens: 100, total_cost: 0.01 }),
      usageEntry({ completion_tokens: 50, total_cost: 0.02 }),
      { ...usageEntry({ prompt_tokens: 10 }), kind: 'image', endpoint: 'images' },
      { ...usageEntry({ prompt_tokens: 999 }), chatId: 'c2' }
    ]);
    const u = service.chatTotals('c1');
    expect(u?.input).toBe(110);
    expect(u?.output).toBe(50);
    expect(u?.cost).toBeCloseTo(0.03, 10);
  });

  it('refreshChat persists the total, storedTotals reloads it', () => {
    setEntries([
      usageEntry({ prompt_tokens: 10, completion_tokens: 20, total_cost: 0.0012 })
    ]);
    const totals = service.refreshChat('c1');
    expect(totals?.cost).toBe(0.0012);
    // The same localStorage snapshot is readable back through storedTotals.
    expect(service.storedTotals('c1')?.cost).toBe(0.0012);
    expect(service.storedTotals('c1')?.input).toBe(10);
  });

  it('clearStored removes the persisted total', () => {
    setEntries([usageEntry({ prompt_tokens: 10, total_cost: 0.0012 })]);
    service.refreshChat('c1');
    service.clearStored('c1');
    expect(service.storedTotals('c1')).toBeNull();
  });

  it('usageFromNode reads the persisted node usage fields', () => {
    const u = service.usageFromNode({
      promptTokens: 120,
      completionTokens: 45,
      cachedTokens: 10,
      totalTokens: 165,
      totalCost: 0.0004
    });
    expect(u?.input).toBe(120);
    expect(u?.output).toBe(45);
    expect(u?.cached).toBe(10);
    expect(u?.total).toBe(165);
    expect(u?.cost).toBeCloseTo(0.0004, 10);
  });

  it('usageFromNode returns null for a node without persisted usage', () => {
    expect(service.usageFromNode({ promptTokens: null, completionTokens: null })).toBeNull();
    expect(service.usageFromNode(null)).toBeNull();
  });

  it('nodeUsagesForChat groups log entries per node and sums', () => {
    setEntries([
      usageEntry({ prompt_tokens: 12, completion_tokens: 30, total_cost: 0.0004 }),
      usageEntry({ prompt_tokens: 8, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } }),
      { ...usageEntry({ prompt_tokens: 50 }), nodeId: 'n2' },
      { ...usageEntry({ prompt_tokens: 999 }), chatId: 'c2' },
      failedEntry()
    ]);
    const byNode = service.nodeUsagesForChat('c1');
    const n1 = byNode.find(e => e.nodeId === 'n1');
    const n2 = byNode.find(e => e.nodeId === 'n2');
    expect(n1?.usage.input).toBe(20);
    expect(n1?.usage.output).toBe(35);
    expect(n1?.usage.cached).toBe(3);
    expect(n1?.usage.cost).toBeCloseTo(0.0004, 10);
    expect(n2?.usage.input).toBe(50);
    expect(byNode).toHaveLength(2);
  });
});