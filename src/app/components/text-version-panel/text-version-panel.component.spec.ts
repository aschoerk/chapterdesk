import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TextVersionPanelComponent } from './text-version-panel.component';
import { TextVersionApiService } from '../../core/texts/text-version-api.service';
import { ConfirmService } from '../../core/dialogs/confirm.service';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TextVersion } from '../../models/text-version';

function makeVersion(partial: Partial<TextVersion> = {}): TextVersion {
  return {
    id: 'v1',
    entityType: 'topic',
    entityId: 'topic-1',
    entityAttribute: 'defaultSystemPrompt',
    versionNumber: 1,
    datetime: '2026-10-01T10:00:00.000Z',
    oldContent: 'Old prompt',
    ...partial,
  };
}

const ATTRIBUTES = [
  { attribute: 'defaultSystemPrompt' as const, label: 'Default system prompt' },
];

describe('TextVersionPanelComponent', () => {
  let fixture: ComponentFixture<TextVersionPanelComponent>;
  let component: TextVersionPanelComponent;
  let api: {
    getTextVersions: ReturnType<typeof vi.fn>;
    restoreTextVersion: ReturnType<typeof vi.fn>;
    deleteTextVersion: ReturnType<typeof vi.fn>;
  };
  let confirm: ConfirmService;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    localStorage.clear();
    api = {
      getTextVersions: vi.fn(async () => []),
      restoreTextVersion: vi.fn(),
      deleteTextVersion: vi.fn(async () => {}),
    };

    await TestBed.configureTestingModule({
      imports: [TextVersionPanelComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: TextVersionApiService, useValue: api },
      ],
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    confirm = TestBed.inject(ConfirmService);

    fixture = TestBed.createComponent(TextVersionPanelComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('entityType', 'topic');
    fixture.componentRef.setInput('attributes', ATTRIBUTES);
    fixture.detectChanges();
  });

  /** Flush signal effects + the async load promise, then re-render. */
  async function flush(): Promise<void> {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  }

  function openPanel(): void {
    (fixture.nativeElement.querySelector('.tvp-toggle') as HTMLElement).click();
    fixture.detectChanges();
  }

  describe('loading', () => {
    it('loads versions for the given entity + attribute when entityId is set', async () => {
      fixture.componentRef.setInput('entityId', 'topic-1');
      await flush();

      expect(api.getTextVersions).toHaveBeenCalledWith('topic', 'topic-1', 'defaultSystemPrompt');
      expect(component.versions().length).toBe(0);
    });

    it('does not load when entityId is null', async () => {
      await flush();
      expect(api.getTextVersions).not.toHaveBeenCalled();
    });

    it('renders version rows with a preview', async () => {
      api.getTextVersions.mockResolvedValue([
        makeVersion({ id: 'v2', versionNumber: 2, oldContent: 'Second prompt' }),
        makeVersion({ id: 'v1', versionNumber: 1, oldContent: 'First prompt' }),
      ]);
      fixture.componentRef.setInput('entityId', 'topic-1');
      await flush();
      openPanel();

      const rows = fixture.nativeElement.querySelectorAll('.tvp-row');
      expect(rows.length).toBe(2);
      expect(rows[0].textContent).toContain('Second prompt');
      expect(rows[1].textContent).toContain('First prompt');
      expect(rows[0].textContent).toContain('V2');
    });

    it('shows the empty hint when there are no versions', async () => {
      fixture.componentRef.setInput('entityId', 'topic-1');
      await flush();
      openPanel();

      expect(fixture.nativeElement.querySelector('.tvp-state')?.textContent).toContain(
        'No versions recorded yet',
      );
    });
  });

  describe('compare', () => {
    it('shows current vs historical content for the compared version', async () => {
      api.getTextVersions.mockResolvedValue([
        makeVersion({ id: 'v1', oldContent: 'Old prompt', datetime: '2026-10-01T10:00:00.000Z' }),
      ]);
      fixture.componentRef.setInput('entityId', 'topic-1');
      fixture.componentRef.setInput('currentValues', { defaultSystemPrompt: 'Live prompt' });
      await flush();
      openPanel();

      (fixture.nativeElement.querySelectorAll('.tvp-actions .btn')[0] as HTMLElement).click();
      fixture.detectChanges();

      const texts = fixture.nativeElement.querySelectorAll('.tvp-text');
      expect(texts.length).toBe(2);
      expect(texts[0].textContent).toContain('Live prompt');
      expect(texts[1].textContent).toContain('Old prompt');
    });
  });

  describe('restore', () => {
    it('restores a version, emits restored and reloads the list', async () => {
      api.getTextVersions.mockResolvedValue([
        makeVersion({ id: 'v1', oldContent: 'Old prompt' }),
      ]);
      api.restoreTextVersion.mockResolvedValue({
        entityType: 'topic',
        entityId: 'topic-1',
        entityAttribute: 'defaultSystemPrompt',
        value: 'Old prompt',
        undoVersion: null,
      });
      vi.spyOn(confirm, 'ask').mockResolvedValue(true);
      const restoredSpy = vi.fn();
      component.restored.subscribe(restoredSpy);

      fixture.componentRef.setInput('entityId', 'topic-1');
      await flush();
      openPanel();

      // Restore button is the second action button (Compare, Restore, Delete).
      const buttons = fixture.nativeElement.querySelectorAll('.tvp-actions .btn');
      (buttons[1] as HTMLElement).click();
      await flush();

      expect(api.restoreTextVersion).toHaveBeenCalledWith('v1');
      expect(restoredSpy).toHaveBeenCalledWith({
        attribute: 'defaultSystemPrompt',
        value: 'Old prompt',
      });
      // reload after restore
      expect(api.getTextVersions.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('does nothing when the user cancels the confirmation', async () => {
      api.getTextVersions.mockResolvedValue([
        makeVersion({ id: 'v1', oldContent: 'Old prompt' }),
      ]);
      vi.spyOn(confirm, 'ask').mockResolvedValue(false);

      fixture.componentRef.setInput('entityId', 'topic-1');
      await flush();
      openPanel();

      const buttons = fixture.nativeElement.querySelectorAll('.tvp-actions .btn');
      (buttons[1] as HTMLElement).click();
      await flush();

      expect(api.restoreTextVersion).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('removes a version entry from the list', async () => {
      api.getTextVersions.mockResolvedValue([
        makeVersion({ id: 'v1', oldContent: 'Old prompt' }),
      ]);
      vi.spyOn(confirm, 'ask').mockResolvedValue(true);

      fixture.componentRef.setInput('entityId', 'topic-1');
      await flush();
      openPanel();
      expect(fixture.nativeElement.querySelectorAll('.tvp-row').length).toBe(1);

      const buttons = fixture.nativeElement.querySelectorAll('.tvp-actions .btn');
      (buttons[2] as HTMLElement).click();
      await flush();

      expect(api.deleteTextVersion).toHaveBeenCalledWith('v1');
      expect(fixture.nativeElement.querySelectorAll('.tvp-row').length).toBe(0);
    });
  });
});
