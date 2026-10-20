import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi } from '../../../../test-helpers/factories';
import { SettingsService } from '../../core/settings.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { IllustrateDialogService } from '../../core/illustrate-dialog.service';
import { IllustrateDialogComponent } from './illustrate-dialog.component';

describe('IllustrateDialogComponent', () => {
  let fixture: ComponentFixture<IllustrateDialogComponent>;
  let component: IllustrateDialogComponent;
  let dialog: IllustrateDialogService;
  let api: InMemoryChatApi;

  beforeEach(async () => {
    localStorage.removeItem('chat.illustrateOptions.v1');
    api = new InMemoryChatApi();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        {
          id: 'img-1', displayName: 'Image One', modelId: 'alpha/image',
          architecture: { input_modalities: ['text'], output_modalities: ['image'] }
        },
        {
          id: 'img-2', displayName: 'Image Two', modelId: 'beta/image',
          architecture: { input_modalities: ['text'], output_modalities: ['image'] }
        },
        {
          id: 'txt-1', displayName: 'Text Only', modelId: 'gamma/text',
          architecture: { input_modalities: ['text'], output_modalities: ['text'] }
        }
      ]
    });
    await TestBed.configureTestingModule({
      imports: [IllustrateDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    await TestBed.inject(SettingsService).loadAll();
    dialog = TestBed.inject(IllustrateDialogService);
    fixture = TestBed.createComponent(IllustrateDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('hidden when the dialog is closed', () => {
    expect(fixture.nativeElement.querySelector('.illustrate-dialog')).toBeNull();
  });

  it('shows the storyboard rules regardless of the scene count', async () => {
    const p = dialog.open();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.illustrate-dialog')).not.toBeNull();

    // The storyboard rules are ALWAYS shown — no special handling for count 1.
    expect(fixture.nativeElement.textContent).toContain('Storyboard rules');

    component.count.set(12);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Storyboard rules');

    dialog.cancel();
    await p;
  });

  it('submit resolves with the entered values and closes', async () => {
    const p = dialog.open();
    fixture.detectChanges();

    component.count.set(2);
    component.style.set('comic style');
    component.storyboardPrompt.set('no explicit images');
    component.submit();
    fixture.detectChanges();

    await expect(p).resolves.toEqual({
      count: 2,
      style: 'comic style',
      storyboardPrompt: 'no explicit images',
      purePictures: false,
      modelId: '',
      providerId: '',
      historyMode: 'single',
      historyNodes: 4,
      storyboardHistoryNodes: 4,
      planDescriptions: true
    });
    expect(fixture.nativeElement.querySelector('.illustrate-dialog')).toBeNull();
  });

  it('shows the image-capable models in a model select', async () => {
    dialog.open();
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector('.ill-field select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    const labels = [...select.options].map(o => o.textContent?.trim());
    expect(labels).toContain('Image One');
    expect(labels).toContain('Image Two');
    expect(labels).not.toContain('Text Only'); // non-image model excluded
    dialog.cancel();
  });

  it('selecting a model updates modelId + providerId and submits them', async () => {
    const p = dialog.open();
    fixture.detectChanges();

    component.onModelChange('beta/image');
    fixture.detectChanges();
    component.submit();
    fixture.detectChanges();

    await expect(p).resolves.toMatchObject({
      modelId: 'beta/image',
      providerId: 'prov-1'
    });
  });

  it('seeds the model select from the options it was opened with', async () => {
    dialog.open({ modelId: 'alpha/image', providerId: 'prov-1' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.modelId()).toBe('alpha/image');
    const select = fixture.nativeElement.querySelector('.ill-field select') as HTMLSelectElement;
    expect(select.value).toBe('alpha/image');
    expect(select.selectedOptions[0].textContent).toContain('Image One');
    dialog.cancel();
  });

  it('toggles pure picture mode and submits it', async () => {
    const p = dialog.open();
    fixture.detectChanges();

    const checkbox = fixture.nativeElement.querySelector('.ill-check input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    component.purePictures.set(true);
    fixture.detectChanges();
    component.submit();
    fixture.detectChanges();

    await expect(p).resolves.toMatchObject({ purePictures: true });
  });

  it('seeds pure picture mode from the last-used options', async () => {
    dialog.submit({ count: 1, style: '', storyboardPrompt: '', purePictures: true, modelId: '', providerId: '', historyMode: 'single', historyNodes: 4, storyboardHistoryNodes: 4, planDescriptions: true });
    dialog.open();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.purePictures()).toBe(true);
    const checkbox = fixture.nativeElement.querySelector('.ill-check input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox?.checked).toBe(true);
    dialog.cancel();
  });

  it('shows the pure picture mode checkbox and its hint', async () => {
    dialog.open();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Pure picture mode');
    expect(text).toContain('never the raw story text');
    dialog.cancel();
  });

  it('shows the context radios for a single picture AND for a storyboard', async () => {
    const p = dialog.open();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ill-radio-group')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Current text only');
    expect(fixture.nativeElement.textContent).toContain('Last beats up to this point');

    component.count.set(3); // storyboard — the window still bounds the planning context
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ill-radio-group')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Last beats up to this point');

    dialog.cancel();
    await p;
  });

  it('selecting the window context submits historyMode window + historyNodes', async () => {
    const p = dialog.open();
    fixture.detectChanges();

    component.historyMode.set('window');
    component.historyNodes.set(6);
    fixture.detectChanges();
    component.submit();
    fixture.detectChanges();

    await expect(p).resolves.toMatchObject({ historyMode: 'window', historyNodes: 6 });
  });

  it('shows a window-width number input that is disabled until the window mode is chosen', async () => {
    // Seed 'single' explicitly — the service singleton may remember a 'window'
    // choice from an earlier test.
    const p = dialog.open({ historyMode: 'single' });
    fixture.detectChanges();

    const countInput = fixture.nativeElement.querySelector('.ill-window-count') as HTMLInputElement;
    expect(countInput).not.toBeNull();
    // Not selected (single mode) → the width input is disabled.
    expect(countInput.disabled).toBe(true);

    component.historyMode.set('window');
    component.historyNodes.set(5);
    fixture.detectChanges();
    expect(countInput.disabled).toBe(false);

    component.onHistoryNodesInput('2');
    fixture.detectChanges();
    expect(component.historyNodes()).toBe(2);

    dialog.cancel();
    await p;
  });

  it('uses and remembers a separate window width for the storyboard use case', async () => {
    const p = dialog.open({ historyMode: 'window', historyNodes: 6, storyboardHistoryNodes: 12 });
    await fixture.whenStable();
    fixture.detectChanges();

    // Single picture (count 1): the input shows the single-picture width.
    expect(component.activeHistoryNodes()).toBe(6);
    const countInput = fixture.nativeElement.querySelector('.ill-window-count') as HTMLInputElement;
    expect(countInput.value).toBe('6');

    // Switch to a storyboard → the input now shows the storyboard width.
    component.count.set(3);
    fixture.detectChanges();
    expect(component.activeHistoryNodes()).toBe(12);
    expect(countInput.value).toBe('12');

    // Editing while in storyboard mode updates ONLY the storyboard width.
    component.onHistoryNodesInput('8');
    fixture.detectChanges();
    expect(component.storyboardHistoryNodes()).toBe(8);
    expect(component.historyNodes()).toBe(6);
    expect(component.activeHistoryNodes()).toBe(8);

    component.submit();
    fixture.detectChanges();
    await expect(p).resolves.toMatchObject({ historyNodes: 6, storyboardHistoryNodes: 8 });
  });

  it('edits the single-picture width when count is 1 and keeps the storyboard width', async () => {
    const p = dialog.open({ historyMode: 'window', historyNodes: 6, storyboardHistoryNodes: 12 });
    await fixture.whenStable();
    fixture.detectChanges();

    component.onHistoryNodesInput('10');
    fixture.detectChanges();
    expect(component.historyNodes()).toBe(10);
    expect(component.storyboardHistoryNodes()).toBe(12);

    component.submit();
    fixture.detectChanges();
    await expect(p).resolves.toMatchObject({ historyNodes: 10, storyboardHistoryNodes: 12 });
  });

  it('seeds the context radios and window width from the opened options', async () => {
    dialog.open({ historyMode: 'window', historyNodes: 8 });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.historyMode()).toBe('window');
    expect(component.historyNodes()).toBe(8);
    const radios = fixture.nativeElement.querySelectorAll('.ill-radio input[type="radio"]');
    expect((radios[1] as HTMLInputElement).checked).toBe(true);
    dialog.cancel();
  });

  it('keeps the window radio selectable in pure picture mode', async () => {
    const p = dialog.open();
    fixture.detectChanges();

    component.purePictures.set(true);
    component.historyMode.set('window');
    fixture.detectChanges();

    // Pure picture mode still lets the user bound the context with the window —
    // the window limits what the PLANNING (text) model sees, not the image model.
    const radios = fixture.nativeElement.querySelectorAll('.ill-radio input[type="radio"]');
    expect((radios[1] as HTMLInputElement).disabled).toBe(false);
    expect((radios[1] as HTMLInputElement).checked).toBe(true);

    component.submit();
    fixture.detectChanges();
    await expect(p).resolves.toMatchObject({ historyMode: 'window', purePictures: true });
  });

  it('clicking "Current text only" and submitting persists historyMode single', async () => {
    const p = dialog.open({ historyMode: 'window' });
    await fixture.whenStable();
    fixture.detectChanges();

    const radios = fixture.nativeElement.querySelectorAll('.ill-radio input[type="radio"]');
    (radios[0] as HTMLInputElement).click();
    fixture.detectChanges();
    component.submit();
    fixture.detectChanges();

    await expect(p).resolves.toMatchObject({ historyMode: 'single' });
  });

  it('shows the planning checkbox enabled by default and submits planDescriptions on', async () => {
    const p = dialog.open();
    fixture.detectChanges();

    const checkboxes = fixture.nativeElement.querySelectorAll('.ill-check input[type="checkbox"]');
    const planningBox = checkboxes[checkboxes.length - 1] as HTMLInputElement;
    expect(planningBox.disabled).toBe(false);
    expect(planningBox.checked).toBe(true);

    component.submit();
    fixture.detectChanges();
    await expect(p).resolves.toMatchObject({ planDescriptions: true });
  });

  it('can turn planning off and submits planDescriptions false', async () => {
    const p = dialog.open();
    fixture.detectChanges();

    component.planDescriptions.set(false);
    component.submit();
    fixture.detectChanges();
    await expect(p).resolves.toMatchObject({ planDescriptions: false });
  });

  it('seeds the planning checkbox from the opened options', async () => {
    dialog.open({ planDescriptions: false });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.planDescriptions()).toBe(false);
    const checkboxes = fixture.nativeElement.querySelectorAll('.ill-check input[type="checkbox"]');
    const planningBox = checkboxes[checkboxes.length - 1] as HTMLInputElement;
    expect(planningBox.checked).toBe(false);
    dialog.cancel();
  });

  it('forces planning back on (disabled checkbox) in pure picture mode', async () => {
    const p = dialog.open();
    fixture.detectChanges();

    component.purePictures.set(true);
    component.planDescriptions.set(false);
    fixture.detectChanges();

    const checkboxes = fixture.nativeElement.querySelectorAll('.ill-check input[type="checkbox"]');
    const planningBox = checkboxes[checkboxes.length - 1] as HTMLInputElement;
    expect(planningBox.disabled).toBe(true);
    // onSubmit (and onPlanChange) clamp back to true.
    component.submit();
    fixture.detectChanges();
    await expect(p).resolves.toMatchObject({ planDescriptions: true, purePictures: true });
  });

  it('cancel closes and resolves null', async () => {
    const p = dialog.open();
    fixture.detectChanges();
    dialog.cancel();
    fixture.detectChanges();
    await expect(p).resolves.toBeNull();
    expect(fixture.nativeElement.querySelector('.illustrate-dialog')).toBeNull();
  });

  it('Escape closes the dialog and resolves null (same as cancel)', async () => {
    const p = dialog.open();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.illustrate-dialog')).not.toBeNull();

    component.onDocumentKey({
      key: 'Escape',
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent);
    fixture.detectChanges();

    await expect(p).resolves.toBeNull();
    expect(fixture.nativeElement.querySelector('.illustrate-dialog')).toBeNull();
  });

  it('ignores Escape while the dialog is closed', () => {
    const preventDefault = vi.fn();
    component.onDocumentKey({ key: 'Escape', preventDefault } as unknown as KeyboardEvent);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.illustrate-dialog')).toBeNull();
  });
});