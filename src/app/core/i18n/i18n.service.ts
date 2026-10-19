import { Injectable, computed, signal } from '@angular/core';
import { EN } from './catalog-en';
import { DE } from './catalog-de';
import { EN_SHELL } from './catalog-shell-en';
import { DE_SHELL } from './catalog-shell-de';
import { EN_WORK } from './catalog-work-en';
import { DE_WORK } from './catalog-work-de';
import { EN_PAGES } from './catalog-pages-en';
import { DE_PAGES } from './catalog-pages-de';

export type AppLocale = 'en' | 'de';

const LS_LOCALE = 'chat.view.locale';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merges the catalogs so nested namespaces (e.g. `sidebar`, `node`,
 * `params`) are combined instead of one whole object replacing the other.
 * A shallow `{...a, ...b}` spread would silently drop keys that only live in
 * an earlier catalog (the work catalogs add clipboard / selection labels to
 * namespaces the main catalog also defines). Leaf values from later catalogs
 * win, so the main catalog keeps precedence for keys it redefines.
 */
function deepMerge(...catalogs: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const catalog of catalogs) {
    for (const [key, value] of Object.entries(catalog)) {
      if (isObject(value) && isObject(out[key])) {
        out[key] = deepMerge(out[key], value);
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

const CATALOGS: Record<AppLocale, Record<string, unknown>> = {
  en: deepMerge(EN_SHELL, EN_WORK, EN_PAGES, EN),
  de: deepMerge(DE_SHELL, DE_WORK, DE_PAGES, DE)
};

function detectLocale(): AppLocale {
  const stored = localStorage.getItem(LS_LOCALE);
  if (stored === 'en' || stored === 'de') return stored;
  const nav = (navigator.language || 'en').toLowerCase();
  return nav.startsWith('de') ? 'de' : 'en';
}

function lookup(tree: Record<string, unknown>, path: string): string | undefined {
  let cur: unknown = tree;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{\{\w+\}\}/g, (match) => {
    const key = match.slice(2, -2);
    return params[key] === undefined ? match : String(params[key]);
  });
}

@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly locale = signal<AppLocale>(detectLocale());
  /** BCP 47 tag for DatePipe / DecimalPipe / Intl. */
  readonly localeId = computed(() => (this.locale() === 'de' ? 'de-DE' : 'en-US'));

  readonly locales: { id: AppLocale; label: string }[] = [
    { id: 'en', label: 'English' },
    { id: 'de', label: 'Deutsch' }
  ];

  constructor() {
    this.applyDocumentLang(this.locale());
  }

  setLocale(locale: AppLocale): void {
    this.locale.set(locale);
    localStorage.setItem(LS_LOCALE, locale);
    this.applyDocumentLang(locale);
  }

  t(key: string, params?: Record<string, string | number>): string {
    const raw =
      lookup(CATALOGS[this.locale()], key) ??
      lookup(CATALOGS.en, key) ??
      key;
    return interpolate(raw, params);
  }

  formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(this.localeId(), options).format(value);
  }

  formatDate(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(this.localeId(), options).format(date);
  }

  private applyDocumentLang(locale: AppLocale): void {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = locale === 'de' ? 'de' : 'en';
  }
}
