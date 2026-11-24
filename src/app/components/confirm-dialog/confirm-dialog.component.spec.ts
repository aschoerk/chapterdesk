import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ConfirmService } from '../../core/dialogs/confirm.service';
import { ConfirmDialogComponent } from './confirm-dialog.component';

describe('ConfirmDialogComponent', () => {
  let fixture: ComponentFixture<ConfirmDialogComponent>;
  let component: ConfirmDialogComponent;
  let confirm: ConfirmService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConfirmDialogComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    confirm = TestBed.inject(ConfirmService);
    confirm.close(false); // reset open state
    fixture = TestBed.createComponent(ConfirmDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('shows nothing while no confirmation is pending', () => {
    expect(fixture.nativeElement.querySelector('.confirm-backdrop')).toBeNull();
  });

  it('renders title + message from the request and resolves true on confirm', async () => {
    const promise = confirm.ask({ title: 'Delete?', message: 'Really delete the story?' });
    fixture.detectChanges();

    const h = fixture.nativeElement.querySelector('#confirm-title');
    const p = fixture.nativeElement.querySelector('#confirm-message');
    expect(h.textContent).toContain('Delete?');
    expect(p.textContent).toContain('Really delete the story?');

    const primary = fixture.nativeElement.querySelector('.confirm-actions .btn.primary');
    primary.dispatchEvent(new Event('click'));
    expect(await promise).toBe(true);
    expect(confirm.current()).toBeNull();
  });

  it('cancel button resolves false', async () => {
    const promise = confirm.ask({ title: 'T', message: 'M' });
    fixture.detectChanges();

    const cancel = fixture.nativeElement.querySelector('.confirm-actions .btn:not(.primary)');
    cancel.dispatchEvent(new Event('click'));
    expect(await promise).toBe(false);
  });

  it('Escape closes with false (document handler + enter closes true)', async () => {
    const promise = confirm.ask({ title: 'T', message: 'M' });
    fixture.detectChanges();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await promise).toBe(false);

    const again = confirm.ask({ title: 'T', message: 'M' });
    fixture.detectChanges();
    const backdrop = fixture.nativeElement.querySelector('.confirm-backdrop');
    backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(await again).toBe(true);
  });

  it('backdrop click only dismisses when the press also started on the backdrop', async () => {
    const promise = confirm.ask({ title: 'T', message: 'M' });
    fixture.detectChanges();
    const backdrop = fixture.nativeElement.querySelector('.confirm-backdrop');

    // mousedown + click on the backdrop itself → dismissed with false.
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(await promise).toBe(false);
    expect(confirm.current()).toBeNull();

    // mousedown inside the dialog but click bubbled to the backdrop → kept open.
    const again = confirm.ask({ title: 'T', message: 'M' });
    fixture.detectChanges();
    const dialogEl = fixture.nativeElement.querySelector('.confirm-dialog');
    dialogEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(confirm.current()).not.toBeNull();
  });

  it('does not close on Escape when no confirmation is open', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(confirm.current()).toBeNull();
  });

  // ------------------------------------------------------------------
  // Optional editable prompt (e.g. "Rewrite in place")
  // ------------------------------------------------------------------

  it('shows no prompt field for a plain confirmation', async () => {
    const promise = confirm.ask({ title: 'T', message: 'M', confirmLabel: 'Yes' });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.confirm-prompt')).toBeNull();
    expect(fixture.nativeElement.querySelector('.confirm-dialog').classList)
      .not.toContain('with-prompt');

    confirm.close(true);
    expect(await promise).toBe(true);
  });

  it('shows the editable prompt pre-filled and resolves with the edited text', async () => {
    const promise = confirm.askWithPrompt({
      title: 'Rewrite this answer in place?',
      message: 'Only this answer is replaced.',
      confirmLabel: 'Rewrite in place',
      cancelLabel: 'Cancel',
      prompt: { label: 'Original prompt', value: 'Write a dark opening.' },
    });
    fixture.detectChanges();
    // ngModel writes the model into the DOM on a microtask.
    await fixture.whenStable();
    fixture.detectChanges();

    const textarea = fixture.nativeElement.querySelector('.confirm-prompt textarea') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(component.promptValue()).toBe('Write a dark opening.');
    expect(textarea.value).toBe('Write a dark opening.');
    expect(fixture.nativeElement.querySelector('.confirm-prompt-label').textContent)
      .toContain('Original prompt');

    textarea.value = 'Write a much darker opening.';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const primary = fixture.nativeElement.querySelector('.confirm-actions .btn.primary') as HTMLButtonElement;
    primary.click();
    expect(await promise).toEqual({ text: 'Write a much darker opening.', modelId: '', providerId: '' });
    expect(confirm.current()).toBeNull();
  });

  it('disables confirm while the prompt is blank', async () => {
    const promise = confirm.askWithPrompt({
      title: 'T', message: 'M', confirmLabel: 'Go',
      prompt: { label: 'Prompt', value: '   ' },
    });
    fixture.detectChanges();

    const primary = fixture.nativeElement.querySelector('.confirm-actions .btn.primary') as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    primary.click();
    expect(confirm.current()).not.toBeNull();

    confirm.close(null);
    expect(await promise).toBeNull();
  });

  it('cancelling a prompt confirmation resolves null (not the text)', async () => {
    const promise = confirm.askWithPrompt({
      title: 'T', message: 'M',
      prompt: { label: 'Prompt', value: 'Text' },
    });
    fixture.detectChanges();

    const cancel = fixture.nativeElement.querySelector('.confirm-actions .btn:not(.primary)') as HTMLButtonElement;
    cancel.click();
    expect(await promise).toBeNull();
  });

  it('Enter inside the prompt inserts a newline; Ctrl+Enter confirms', async () => {
    const promise = confirm.askWithPrompt({
      title: 'T', message: 'M',
      prompt: { label: 'Prompt', value: 'Text' },
    });
    fixture.detectChanges();

    const backdrop = fixture.nativeElement.querySelector('.confirm-backdrop');
    backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(confirm.current()).not.toBeNull();

    backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    expect(await promise).toEqual({ text: 'Text', modelId: '', providerId: '' });
  });

  // ------------------------------------------------------------------
  // Optional model picker ("Rewrite in place")
  // ------------------------------------------------------------------

  it('shows the model picker with the request\'s preselect', async () => {
    const promise = confirm.askWithPrompt({
      title: 'T', message: 'M',
      prompt: {
        label: 'Prompt', value: 'Text',
        model: {
          label: 'Model',
          value: 'b/model',
          title: 'Pick one',
          options: [
            { id: 'a/model', label: 'Alpha', providerId: 'prov-a' },
            { id: 'b/model', label: 'Beta', providerId: 'prov-b' },
          ],
        },
      },
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector('.confirm-model select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.title).toBe('Pick one');
    expect(Array.from(select.options).map(o => o.value)).toEqual(['a/model', 'b/model']);
    expect(select.value).toBe('b/model');
    expect(fixture.nativeElement.querySelector('.confirm-model .confirm-prompt-label').textContent)
      .toContain('Model');

    confirm.close(null);
    expect(await promise).toBeNull();
  });

  it('falls back to the first model when the preselect is not selectable', async () => {
    const promise = confirm.askWithPrompt({
      title: 'T', message: 'M',
      prompt: {
        label: 'Prompt', value: 'Text',
        model: {
          label: 'Model', value: 'gone/model',
          options: [{ id: 'a/model', label: 'Alpha', providerId: 'prov-a' }],
        },
      },
    });
    fixture.detectChanges();

    expect(component.modelValue()).toBe('a/model');

    confirm.close(null);
    expect(await promise).toBeNull();
  });

  it('resolves with the chosen model and its provider', async () => {
    const promise = confirm.askWithPrompt({
      title: 'T', message: 'M',
      prompt: {
        label: 'Prompt', value: 'Text',
        model: {
          label: 'Model', value: 'a/model',
          options: [
            { id: 'a/model', label: 'Alpha', providerId: 'prov-a' },
            { id: 'b/model', label: 'Beta', providerId: 'prov-b' },
          ],
        },
      },
    });
    fixture.detectChanges();

    component.onModelInput('b/model');
    const primary = fixture.nativeElement.querySelector('.confirm-actions .btn.primary') as HTMLButtonElement;
    primary.click();

    expect(await promise).toEqual({
      text: 'Text', modelId: 'b/model', providerId: 'prov-b',
    });
  });
});