import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ModelSelectComponent } from './model-select.component';
import { I18nService } from '../../core/i18n/i18n.service';
import { ModelRecencyService } from '../../core/settings/model-recency.service';
import { makeModel } from '../../../../test-helpers/factories';

const ALPHA = makeModel({ id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model' });
const BETA = makeModel({ id: 'm-2', displayName: 'Beta', modelId: 'beta/model' });
const GAMMA = makeModel({ id: 'm-3', displayName: 'Gamma', modelId: 'gamma/model' });

describe('ModelSelectComponent', () => {
  let fixture: ComponentFixture<ModelSelectComponent>;
  let component: ModelSelectComponent;
  let recency: ModelRecencyService;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [ModelSelectComponent],
      providers: [provideZonelessChangeDetection()]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    recency = TestBed.inject(ModelRecencyService);
    fixture = TestBed.createComponent(ModelSelectComponent);
    component = fixture.componentInstance;
  });

  function render(models = [ALPHA, BETA, GAMMA], value = ''): void {
    fixture.componentRef.setInput('models', models);
    fixture.componentRef.setInput('value', value);
    fixture.detectChanges();
  }

  function groups(): { label: string; options: string[] }[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('optgroup') as NodeListOf<HTMLOptGroupElement>,
    ).map(g => ({
      label: g.getAttribute('label') ?? '',
      options: Array.from(g.querySelectorAll('option')).map(o => o.textContent?.trim() ?? ''),
    }));
  }

  it('shows a single "all models" group without a current or recent model', () => {
    render();

    expect(groups()).toEqual([
      { label: 'All models', options: ['Alpha', 'Beta', 'Gamma'] },
    ]);
  });

  it('puts the current model first, then the recently used ones, then the rest', () => {
    recency.remember('beta/model');
    recency.remember('gamma/model');
    render([ALPHA, BETA, GAMMA], 'alpha/model');

    expect(groups()).toEqual([
      { label: 'Current model', options: ['Alpha'] },
      { label: 'Recently used', options: ['Gamma', 'Beta'] },
    ]);
  });

  it('never repeats a model across the groups', () => {
    // The current model is also the most recently used one.
    recency.remember('alpha/model');
    recency.remember('beta/model');
    render([ALPHA, BETA, GAMMA], 'alpha/model');

    const all = groups().flatMap(g => g.options);
    expect(all).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(new Set(all).size).toBe(all.length);
  });

  it('drops recently used models that are no longer offered', () => {
    recency.remember('gone/model');
    render([ALPHA, BETA], 'alpha/model');

    expect(groups()).toEqual([
      { label: 'Current model', options: ['Alpha'] },
      { label: 'All models', options: ['Beta'] },
    ]);
  });

  it('emits the picked model id', () => {
    render([ALPHA, BETA], 'alpha/model');
    const emitted: string[] = [];
    component.valueChange.subscribe(id => emitted.push(id));

    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'beta/model';
    select.dispatchEvent(new Event('change'));

    expect(emitted).toEqual(['beta/model']);
  });

  it('applies the host class, title and disabled state to the inner select', () => {
    fixture.componentRef.setInput('models', [ALPHA]);
    fixture.componentRef.setInput('value', 'alpha/model');
    fixture.componentRef.setInput('selectClass', 'my-select');
    fixture.componentRef.setInput('title', 'Pick a model');
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    expect(select.classList.contains('my-select')).toBe(true);
    expect(select.getAttribute('title')).toBe('Pick a model');
    expect(select.disabled).toBe(true);
  });

  it('localizes the group captions', () => {
    fixture.componentRef.setInput('models', [ALPHA, BETA]);
    fixture.componentRef.setInput('value', 'alpha/model');
    recency.remember('beta/model');
    TestBed.inject(I18nService).setLocale('de');
    fixture.detectChanges();

    expect(groups()).toEqual([
      { label: 'Aktuelles Modell', options: ['Alpha'] },
      { label: 'Zuletzt verwendet', options: ['Beta'] },
    ]);
  });
});
