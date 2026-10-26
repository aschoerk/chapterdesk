import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ConfirmService } from '../../core/dialogs/confirm.service';
import { ConfirmDialogComponent } from './confirm-dialog.component';

describe('ConfirmDialogComponent', () => {
  let fixture: ComponentFixture<ConfirmDialogComponent>;
  let confirm: ConfirmService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConfirmDialogComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    confirm = TestBed.inject(ConfirmService);
    confirm.close(false); // reset open state
    fixture = TestBed.createComponent(ConfirmDialogComponent);
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
});