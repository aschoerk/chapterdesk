import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { RewriteInPlaceDialogComponent } from './rewrite-in-place-dialog.component';
import { RewriteInPlaceDialogService } from '../../core/dialogs/rewrite-in-place-dialog.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { makeModel, makeNode } from '../../../../test-helpers/factories';

describe('RewriteInPlaceDialogComponent', () => {
  let fixture: ComponentFixture<RewriteInPlaceDialogComponent>;
  let component: RewriteInPlaceDialogComponent;
  let dialog: RewriteInPlaceDialogService;

  const models = [
    makeModel({ id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model', providerId: 'prov-1' }),
    makeModel({ id: 'm-2', displayName: 'Beta', modelId: 'beta/model', providerId: 'prov-2' }),
  ];

  function open(followingCount = 0, originalPrompt = ''): Promise<unknown> {
    return dialog.open({
      node: makeNode({ id: 'a1', role: 'assistant', content: 'Answer' }),
      chat: null,
      models,
      modelId: 'alpha/model',
      providerId: 'prov-1',
      followingCount,
      originalPrompt,
    });
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RewriteInPlaceDialogComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    dialog = TestBed.inject(RewriteInPlaceDialogService);
    dialog.cancel(); // reset any open state
    fixture = TestBed.createComponent(RewriteInPlaceDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('shows nothing while no dialog is open', () => {
    expect(fixture.nativeElement.querySelector('.rip-backdrop')).toBeNull();
  });

  it('renders the following count, prefilled model and resolves the specification', async () => {
    const promise = open(2);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('#rip-title').textContent).toContain('Rewrite');
    expect(fixture.nativeElement.querySelector('#rip-message').textContent).toContain('2');
    // The specification field is present; the model picker preselected.
    expect(fixture.nativeElement.querySelector('.rip-field textarea')).not.toBeNull();
    expect(component.modelId()).toBe('alpha/model');
    // All three "send along" checkboxes are on by default when text follows.
    expect(component.includeHistory()).toBe(true);
    expect(component.includeContent()).toBe(true);
    expect(component.includeFollowing()).toBe(true);
    expect(fixture.nativeElement.querySelectorAll('.rip-include-option input')).toHaveLength(3);

    component.specification.set('Make it darker.');
    fixture.detectChanges();
    const primary = fixture.nativeElement.querySelector('.rip-actions .btn.primary');
    primary.dispatchEvent(new Event('click'));

    expect(await promise).toEqual({
      specification: 'Make it darker.',
      includeHistory: true,
      includeContent: true,
      includeFollowing: true,
      modelId: 'alpha/model',
      providerId: 'prov-1',
    });
    expect(dialog.current()).toBeNull();
  });

  it('disables the following-text box when nothing follows', async () => {
    open(0);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.includeFollowing()).toBe(false);
    const options = fixture.nativeElement.querySelectorAll('.rip-include-option');
    expect(options[2].classList).toContain('disabled');
    expect((options[2].querySelector('input') as HTMLInputElement).disabled).toBe(true);
  });

  it('reports the unchecked parts in the result', async () => {
    const promise = open(1);
    fixture.detectChanges();

    component.includeHistory.set(false);
    component.includeContent.set(false);
    component.includeFollowing.set(false);
    fixture.detectChanges();
    component.submit();

    expect(await promise).toEqual({
      specification: '',
      includeHistory: false,
      includeContent: false,
      includeFollowing: false,
      modelId: 'alpha/model',
      providerId: 'prov-1',
    });
  });

  it('pre-fills the specification with the original prompt when the current text is not sent', async () => {
    const promise = open(0, 'Write a scene about a lighthouse keeper');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // While the answer's own text is sent, the box stays empty…
    expect(component.specification()).toBe('');

    // …turning that off switches to "write from scratch" and offers the
    // original prompt for adaptation in the edit box.
    component.setIncludeContent(false);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.includeContent()).toBe(false);
    expect(component.specification()).toBe('Write a scene about a lighthouse keeper');
    const textarea = fixture.nativeElement.querySelector('.rip-field textarea');
    expect(textarea.value).toBe('Write a scene about a lighthouse keeper');

    // The adapted prompt travels as the specification.
    component.specification.set('Write a scene about a lighthouse keeper and a storm.');
    component.submit();
    expect(await promise).toEqual({
      specification: 'Write a scene about a lighthouse keeper and a storm.',
      includeHistory: true,
      includeContent: false,
      includeFollowing: false,
      modelId: 'alpha/model',
      providerId: 'prov-1',
    });
  });

  it('clears the auto-filled prompt again when the current text is sent', async () => {
    open(0, 'Original direction');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.setIncludeContent(false);
    expect(component.specification()).toBe('Original direction');

    component.setIncludeContent(true);
    expect(component.includeContent()).toBe(true);
    expect(component.specification()).toBe('');
  });

  it('keeps a user-edited specification when the current text is sent again', async () => {
    open(0, 'Original direction');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.setIncludeContent(false);
    component.specification.set('Something else entirely');
    component.setIncludeContent(true);

    expect(component.specification()).toBe('Something else entirely');
  });

  it('uses the provider of a model picked in the dialog', async () => {
    const promise = open();
    fixture.detectChanges();

    component.onModelChange('beta/model');
    fixture.detectChanges();
    component.submit();

    expect(await promise).toEqual({
      specification: '',
      includeHistory: true,
      includeContent: true,
      includeFollowing: false,
      modelId: 'beta/model',
      providerId: 'prov-2',
    });
  });

  it('cancel and Escape resolve null', async () => {
    const promise = open();
    fixture.detectChanges();
    const cancel = fixture.nativeElement.querySelector('.rip-actions .btn:not(.primary)');
    cancel.dispatchEvent(new Event('click'));
    expect(await promise).toBeNull();

    const again = open();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await again).toBeNull();
    expect(dialog.current()).toBeNull();
  });

  it('does not close on Escape while no dialog is open', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dialog.current()).toBeNull();
  });
});
