import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ToastHostComponent } from './toast-host.component';
import { ToastService } from '../../core/toast/toast.service';

describe('ToastHostComponent', () => {
  let fixture: ComponentFixture<ToastHostComponent>;
  let toast: ToastService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ToastHostComponent]
    }).compileComponents();
    toast = TestBed.inject(ToastService);
    toast.clear();
    fixture = TestBed.createComponent(ToastHostComponent);
    fixture.detectChanges();
  });

  afterEach(() => toast.clear());

  it('renders nothing while no toasts are queued', () => {
    expect(fixture.nativeElement.querySelector('.toast')).toBeNull();
  });

  it('renders one toast per message with a kind class and its text', () => {
    toast.error('boom');
    toast.info('a note');
    fixture.detectChanges();

    const els = fixture.nativeElement.querySelectorAll('.toast');
    expect(els.length).toBe(2);
    expect(fixture.nativeElement.textContent).toContain('boom');
    expect(fixture.nativeElement.textContent).toContain('a note');
    const first = els[0] as HTMLElement;
    expect(first.classList.contains('toast-error')).toBe(true);
  });

  it('dismisses a toast via its close button', () => {
    toast.error('boom');
    fixture.detectChanges();
    const close = fixture.nativeElement.querySelector('.toast-close') as HTMLButtonElement;
    close.click();
    fixture.detectChanges();
    expect(toast.toasts().length).toBe(0);
    expect(fixture.nativeElement.querySelector('.toast')).toBeNull();
  });
});