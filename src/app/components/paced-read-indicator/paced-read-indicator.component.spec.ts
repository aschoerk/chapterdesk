import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { PacedReadIndicatorComponent } from './paced-read-indicator.component';
import { CHAT_API } from '../../api/chat-api.token';
import { I18nService } from '../../core/i18n/i18n.service';
import { PacedReadService } from '../../core/llm/paced-read.service';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';

/**
 * PacedReadIndicatorComponent — the global "paced reading is paused" pill.
 *
 * It renders only when a session is active AND paused AND no reading view is
 * mounted (`PacedReadService.viewLinked`), so every test drives those three
 * signals directly. The `P` shortcut is a `@HostListener('window:keydown')`
 * and is only handled here when the user is NOT on /chat or /read (both pages
 * own the key while mounted) — asserted through the mocked Router url.
 */
describe('PacedReadIndicatorComponent', () => {
  let fixture: ComponentFixture<PacedReadIndicatorComponent>;
  let component: PacedReadIndicatorComponent;
  let pacedRead: PacedReadService;
  let i18n: I18nService;

  /** The component only reads `Router.url` (and navigates on resume). */
  const router = { url: '/settings', navigate: vi.fn(async () => true) };

  beforeEach(async () => {
    TestBed.resetTestingModule();
    localStorage.clear();
    router.url = '/settings';
    router.navigate.mockClear();

    await TestBed.configureTestingModule({
      imports: [PacedReadIndicatorComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: new InMemoryChatApi() },
        { provide: Router, useValue: router },
      ],
    }).compileComponents();

    i18n = TestBed.inject(I18nService);
    i18n.setLocale('en');
    pacedRead = TestBed.inject(PacedReadService);

    fixture = TestBed.createComponent(PacedReadIndicatorComponent);
    component = fixture.componentInstance;
  });

  // ------------------------------------------------------------------
  // Harness
  // ------------------------------------------------------------------

  /** Put the shared pacing state into a paused-session shape. */
  function setSession(opts: {
    active?: boolean;
    paused?: boolean;
    viewLinked?: boolean;
    total?: number;
    currentIndex?: number;
  } = {}): void {
    pacedRead.active.set(opts.active ?? true);
    pacedRead.paused.set(opts.paused ?? true);
    pacedRead.viewLinked.set(opts.viewLinked ?? false);
    pacedRead.total.set(opts.total ?? 3);
    pacedRead.currentIndex.set(opts.currentIndex ?? 0);
    fixture.detectChanges();
  }

  function pill(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.paced-indicator');
  }

  function buttons(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.paced-indicator button')) as HTMLButtonElement[];
  }

  function resumeButton(): HTMLButtonElement {
    return buttons()[0];
  }

  function stopButton(): HTMLButtonElement {
    return buttons()[1];
  }

  /** Dispatch the `P` shortcut on `window` (the host listener target). */
  function pressKey(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    window.dispatchEvent(event);
    fixture.detectChanges();
    return event;
  }

  // ------------------------------------------------------------------
  // Visibility
  // ------------------------------------------------------------------

  describe('visibility', () => {
    it('renders nothing while no paced read is active', () => {
      setSession({ active: false });
      expect(pill()).toBeNull();
    });

    it('renders nothing while the reveal is running (not paused)', () => {
      setSession({ paused: false });
      expect(pill()).toBeNull();
    });

    it('renders nothing while a reading view is mounted', () => {
      setSession({ viewLinked: true });
      expect(pill()).toBeNull();
    });

    it('renders the pill when the session is paused and no view is on screen', () => {
      setSession();
      expect(pill()).not.toBeNull();
    });

    it('appears and disappears as the state changes', () => {
      setSession({ paused: false });
      expect(pill()).toBeNull();

      pacedRead.paused.set(true);
      fixture.detectChanges();
      expect(pill()).not.toBeNull();

      pacedRead.stop();
      fixture.detectChanges();
      expect(pill()).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // Content
  // ------------------------------------------------------------------

  describe('content', () => {
    it('is a status region labelled with the indicator title', () => {
      setSession();
      const el = pill()!;
      expect(el.getAttribute('role')).toBe('status');
      expect(el.getAttribute('aria-label')).toBe(i18n.t('chat.pacedReadIndicatorTitle'));
    });

    it('shows the paused label and both actions', () => {
      setSession();
      const strong = fixture.nativeElement.querySelector('.paced-indicator .paced-text strong') as HTMLElement;
      expect(strong.textContent?.trim()).toBe(i18n.t('chat.pacedReadPaused'));
      expect(buttons().length).toBe(2);
      expect(resumeButton().textContent).toContain(i18n.t('chat.pacedReadResumeWhere'));
      expect(stopButton().textContent).toContain(i18n.t('chat.pacedReadStop'));
      expect(resumeButton().getAttribute('title')).toBe(i18n.t('chat.pacedReadIndicatorTitle'));
      expect(stopButton().getAttribute('title')).toBe(i18n.t('chat.pacedReadStopTitle'));
    });

    it('shows the 1-based chapter counter while a queue exists', () => {
      setSession({ total: 3, currentIndex: 1 });
      const count = fixture.nativeElement.querySelector('.paced-indicator .paced-count') as HTMLElement;
      expect(count).not.toBeNull();
      expect(count.textContent?.trim()).toBe(
        i18n.t('chat.pacedReadProgress', { current: 2, total: 3 }),
      );
    });

    it('omits the counter when the queue is empty', () => {
      setSession({ total: 0 });
      expect(fixture.nativeElement.querySelector('.paced-indicator .paced-count')).toBeNull();
    });

    it('uses the translated labels of the active locale', () => {
      setSession();
      i18n.setLocale('de');
      fixture.detectChanges();
      const strong = fixture.nativeElement.querySelector('.paced-indicator .paced-text strong') as HTMLElement;
      expect(strong.textContent?.trim()).toBe(i18n.t('chat.pacedReadPaused'));
      expect(resumeButton().textContent).toContain(i18n.t('chat.pacedReadResumeWhere'));
      expect(stopButton().textContent).toContain(i18n.t('chat.pacedReadStop'));
    });
  });

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  describe('actions', () => {
    it('resumes the paused session from the pill button', () => {
      setSession();
      resumeButton().click();
      fixture.detectChanges();

      expect(pacedRead.paused()).toBe(false);
      // Still running — the pill simply goes away.
      expect(pacedRead.active()).toBe(true);
      expect(pill()).toBeNull();
    });

    it('stops the session from the pill button', () => {
      setSession();
      stopButton().click();
      fixture.detectChanges();

      expect(pacedRead.active()).toBe(false);
      expect(pacedRead.total()).toBe(0);
      expect(pill()).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // The `P` shortcut
  // ------------------------------------------------------------------

  describe('the P shortcut', () => {
    it('resumes from any other page', () => {
      setSession();
      const event = pressKey('p');

      expect(pacedRead.paused()).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    });

    it('accepts the uppercase key too', () => {
      setSession();
      pressKey('P');
      expect(pacedRead.paused()).toBe(false);
    });

    it('is ignored while the pill is not shown', () => {
      setSession({ paused: false });
      const event = pressKey('p');

      expect(pacedRead.paused()).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });

    it('is left to the chat page while /chat is open', () => {
      router.url = '/chat/chat-1?x=1';
      setSession();
      const event = pressKey('p');

      expect(pacedRead.paused()).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    });

    it('is left to the reader while /read is open', () => {
      router.url = '/read';
      setSession();
      pressKey('p');
      expect(pacedRead.paused()).toBe(true);
    });

    it('ignores other keys', () => {
      setSession();
      const event = pressKey('r');

      expect(pacedRead.paused()).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    });

    it('ignores modified presses', () => {
      setSession();

      for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
        pressKey('p', init);
        expect(pacedRead.paused()).toBe(true);
      }
    });

    it('ignores a press that another handler already consumed', () => {
      setSession();
      // An earlier handler (e.g. the shortcut-help panel) cancels the event —
      // the capture-phase listener runs before the component's window listener.
      const consume = (e: Event) => e.preventDefault();
      window.addEventListener('keydown', consume, true);
      const target = document.createElement('div');
      fixture.nativeElement.appendChild(target);
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true }));
      fixture.detectChanges();
      window.removeEventListener('keydown', consume, true);

      expect(pacedRead.paused()).toBe(true);
      target.remove();
    });

    it('ignores presses while the user types into a field', () => {
      setSession();
      const input = document.createElement('input');
      fixture.nativeElement.appendChild(input);

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true }));
      fixture.detectChanges();

      expect(pacedRead.paused()).toBe(true);
      input.remove();
    });

    it('ignores presses made inside a textarea or a select', () => {
      setSession();
      for (const tag of ['textarea', 'select']) {
        const el = document.createElement(tag);
        fixture.nativeElement.appendChild(el);
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true }));
        fixture.detectChanges();
        expect(pacedRead.paused()).toBe(true);
        el.remove();
      }
    });
  });

  // ------------------------------------------------------------------
  // Signal delegation
  // ------------------------------------------------------------------

  it('exposes the service signals the template binds to', () => {
    setSession({ total: 5, currentIndex: 4 });
    expect(component.pacedRead.total()).toBe(5);
    expect(component.pacedRead.currentIndex()).toBe(4);
    expect(component.visible).toBe(true);

    pacedRead.viewLinked.set(true);
    expect(component.visible).toBe(false);
  });
});
