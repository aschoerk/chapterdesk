import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, input, output, provideZonelessChangeDetection } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { I18nService } from '../../core/i18n/i18n.service';
import { NodeVersionDiffDialogService } from '../../core/dialogs/node-version-diff-dialog.service';
import { NodeVersionDiffDialogComponent } from './node-version-diff-dialog.component';
import { ChatNode } from '../../models/chat';

/** Shared state the fake Monaco diff editor reads/writes. */
let fakeState: {
  changes: unknown[];
  originalValue: string;
  modifiedValue: string;
  executeEdits: ReturnType<typeof vi.fn>;
};

function makeFakeEditor() {
  return {
    getLineChanges: () => fakeState.changes,
    getModifiedEditor: () => ({
      getValue: () => fakeState.modifiedValue,
      onDidChangeModelContent: () => ({ dispose: () => {} }),
      executeEdits: fakeState.executeEdits,
      revealLineInCenter: vi.fn(),
    }),
    getOriginalEditor: () => ({ revealLineInCenter: vi.fn() }),
    getModel: () => ({ original: { getValue: () => fakeState.originalValue } }),
    revealPositionInCenter: vi.fn(),
  };
}

/** Stand-in for the real ngx-monaco-diff-editor (Monaco cannot run in jsdom). */
@Component({
  selector: 'ngx-monaco-diff-editor',
  standalone: true,
  template: '<div class="fake-diff"></div>',
})
class FakeDiffEditorComponent {
  readonly options = input<unknown>();
  readonly originalModel = input<unknown>();
  readonly modifiedModel = input<unknown>();
  readonly onInit = output<unknown>();

  ngAfterViewInit(): void {
    this.onInit.emit(makeFakeEditor());
  }
}

function node(partial: Partial<ChatNode>): ChatNode {
  return {
    id: 'n1',
    chatId: 'c1',
    parentId: null,
    role: 'assistant',
    content: '',
    thinking: null,
    modelId: null,
    providerId: null,
    version: 1,
    previousVersionId: null,
    isCurrent: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    attachments: [],
    ...partial,
  } as ChatNode;
}

const versions = [
  node({ id: 'v3', version: 3, content: 'line1\nnew line\nline3' }),
  node({ id: 'v2', version: 2, content: 'line1\nold line\nline3' }),
];

const change = {
  originalStartLineNumber: 2,
  originalEndLineNumber: 2,
  originalStartColumn: 1,
  originalEndColumn: 1,
  modifiedStartLineNumber: 2,
  modifiedEndLineNumber: 2,
  modifiedStartColumn: 1,
  modifiedEndColumn: 1,
  charChanges: null,
};

describe('NodeVersionDiffDialogComponent (Monaco)', () => {
  let fixture: ComponentFixture<NodeVersionDiffDialogComponent>;
  let component: NodeVersionDiffDialogComponent;
  let dialog: NodeVersionDiffDialogService;

  beforeAll(() => {
    // jsdom lacks window.matchMedia, which ThemeService reads in its constructor.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  beforeEach(async () => {
    fakeState = {
      changes: [change],
      originalValue: 'line1\nold line\nline3',
      modifiedValue: 'line1\nnew line\nline3',
      executeEdits: vi.fn(() => []),
    };
    await TestBed.configureTestingModule({
      imports: [NodeVersionDiffDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() },
      ],
    })
      .overrideComponent(NodeVersionDiffDialogComponent, {
        set: { imports: [FormsModule, FakeDiffEditorComponent] },
      })
      .compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    dialog = TestBed.inject(NodeVersionDiffDialogService);
    fixture = TestBed.createComponent(NodeVersionDiffDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('is hidden when the dialog is closed', () => {
    expect(fixture.nativeElement.querySelector('.nvd-dialog')).toBeNull();
  });

  it('seeds the modified model and selects the newest version', async () => {
    const p = dialog.open({ newText: 'line1\nEDITED\nline3', versions });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.nvd-dialog')).not.toBeNull();
    expect(component.selectedVersion()?.id).toBe('v3');
    expect(component.modifiedModel().code).toBe('line1\nEDITED\nline3');
    expect(component.originalModel().code).toBe('line1\nnew line\nline3');

    dialog.cancel();
    await p;
  });

  it('sibling mode uses siblings as the read-only compare-with list', async () => {
    const siblings = [
      node({ id: 's1', version: 1, content: 'sibling A text' }),
      node({ id: 's2', version: 1, content: 'sibling B text' }),
    ];
    const p = dialog.open({ newText: 'current node text', siblings });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.isSiblingMode()).toBe(true);
    expect(component.versions().map((v) => v.id)).toEqual(['s1', 's2']);
    expect(component.selectedVersion()?.id).toBe('s1');
    expect(component.originalModel().code).toBe('sibling A text');
    expect(component.modifiedModel().code).toBe('current node text');
    expect(component.optionLabel(siblings[1])).toContain('sibling B');

    dialog.cancel();
    await p;
  });

  it('version mode keeps prior-version labels (not sibling previews)', async () => {
    const p = dialog.open({ newText: 'x', versions: [node({ id: 'v1', version: 5, content: 'a\nb', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })] });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.isSiblingMode()).toBe(false);
    expect(component.optionLabel(component.selectedVersion()!)).toContain('v5');

    dialog.cancel();
    await p;
  });

  it('onInit derives change info from Monaco line changes', async () => {
    const p = dialog.open({ newText: 'line1\nEDITED\nline3', versions });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.hasDiff()).toBe(true);
    expect(component.info().count).toBe(1);
    expect(component.info().added).toBe(1);
    expect(component.info().removed).toBe(1);

    dialog.cancel();
    await p;
  });

  it('navigates between changes with next/prev (wrapping)', async () => {
    fakeState.changes = [
      { ...change, originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 },
      { ...change, originalStartLineNumber: 4, originalEndLineNumber: 4, modifiedStartLineNumber: 4, modifiedEndLineNumber: 4 },
    ];
    const p = dialog.open({
      newText: 'a\nb\nc\nd',
      versions: [node({ id: 'v1', version: 1, content: 'a\nB\nc\nD' })],
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.info().count).toBe(2);
    expect(component.changeIndex()).toBe(0);
    component.nextChange();
    expect(component.changeIndex()).toBe(1);
    component.nextChange();
    expect(component.changeIndex()).toBe(0); // wraps
    component.prevChange();
    expect(component.changeIndex()).toBe(1);

    dialog.cancel();
    await p;
  });

  it('restore change replaces the current block from the old version', async () => {
    const p = dialog.open({ newText: 'line1\nnew line\nline3', versions });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.restoreCurrentChange();
    const edit = fakeState.executeEdits.mock.calls[0][1][0];
    expect(edit.text).toBe('old line');
    expect(edit.range.startLineNumber).toBe(2);
    expect(edit.range.endLineNumber).toBe(2);

    dialog.cancel();
    await p;
  });

  it('restore change re-inserts a pure deletion at the right position', async () => {
    fakeState.changes = [
      {
        originalStartLineNumber: 2,
        originalEndLineNumber: 2,
        originalStartColumn: 1,
        originalEndColumn: 1,
        modifiedStartLineNumber: null,
        modifiedEndLineNumber: null,
        modifiedStartColumn: null,
        modifiedEndColumn: null,
        charChanges: null,
      },
    ];
    const p = dialog.open({ newText: 'line1\nline3', versions });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.restoreCurrentChange();
    const edit = fakeState.executeEdits.mock.calls[0][1][0];
    expect(edit.text).toBe('old line\n');
    expect(edit.range.startLineNumber).toBe(1);

    dialog.cancel();
    await p;
  });

  it('apply resolves with the edited modified value and closes', async () => {
    fakeState.modifiedValue = 'line1\nhand edited\nline3';
    const p = dialog.open({ newText: 'line1\nnew line\nline3', versions });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.apply();
    fixture.detectChanges();

    await expect(p).resolves.toBe('line1\nhand edited\nline3');
    expect(fixture.nativeElement.querySelector('.nvd-dialog')).toBeNull();
  });

  it('cancel resolves null without touching the caller draft', async () => {
    const p = dialog.open({ newText: 'line1\nnew line\nline3', versions });
    fixture.detectChanges();
    dialog.cancel();
    await expect(p).resolves.toBeNull();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.nvd-dialog')).toBeNull();
  });

  it('Escape closes the dialog and resolves null (same as cancel)', async () => {
    const p = dialog.open({ newText: 'line1\nnew line\nline3', versions });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.nvd-dialog')).not.toBeNull();

    component.onDocumentKey({
      key: 'Escape',
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
    fixture.detectChanges();

    await expect(p).resolves.toBeNull();
    expect(fixture.nativeElement.querySelector('.nvd-dialog')).toBeNull();
  });

  it('ignores Escape while the dialog is closed', () => {
    const preventDefault = vi.fn();
    component.onDocumentKey({
      key: 'Escape',
      preventDefault,
    } as unknown as KeyboardEvent);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.nvd-dialog')).toBeNull();
  });

  it('resize drag updates the size signal', () => {
    const p = dialog.open({ newText: 'a', versions: [node({ id: 'v1', version: 1, content: 'a' })] });
    fixture.detectChanges();

    component.startResize({
      clientX: 100,
      clientY: 100,
      preventDefault: () => {},
    } as unknown as MouseEvent);
    component.onDocMouseMove({ clientX: 200, clientY: 150 } as unknown as MouseEvent);
    expect(component.size()).not.toBeNull();
    expect(component.size()!.w).toBeGreaterThan(0);
    component.onDocMouseUp();
    expect(component.resizing()).toBe(false);
    component.dialog.cancel();
    void p;
  });
});