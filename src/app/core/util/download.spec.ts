import { describe, it, expect, afterEach, vi } from 'vitest';
import { isDataUrl, isHttpUrl, filenameFromUrl, downloadUrl } from './download';

function mockAnchorClick() {
  const click = vi.fn();
  const originalCreate = document.createElement.bind(document);
  const create = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'a') {
      return { href: '', download: '', click, remove: vi.fn() } as unknown as HTMLAnchorElement;
    }
    return originalCreate(tag) as HTMLElement;
  });
  const append = vi.spyOn(document.body, 'appendChild').mockImplementation(() => ({} as HTMLElement));
  return { click, create, append };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('download helpers', () => {
  it('classifies data: and http(s) URLs', () => {
    expect(isDataUrl('data:image/png;base64,AAA')).toBe(true);
    expect(isDataUrl('https://example.com/a.png')).toBe(false);
    expect(isHttpUrl('https://example.com/a.png')).toBe(true);
    expect(isHttpUrl('http://example.com/a.png')).toBe(true);
    expect(isHttpUrl('data:image/png;base64,AAA')).toBe(false);
    expect(isHttpUrl('blob:http://example.com')).toBe(false);
  });

  it('derives a filename from a data URL mime type', () => {
    expect(filenameFromUrl('data:image/png;base64,AAA')).toBe('image.png');
    expect(filenameFromUrl('data:image/jpeg;base64,AAA')).toBe('image.jpeg');
    expect(filenameFromUrl('data:image/svg+xml;base64,AAA')).toBe('image.svg');
  });

  it('derives a filename from an http URL path', () => {
    expect(filenameFromUrl('https://example.com/pictures/hero.png')).toBe('hero.png');
    expect(filenameFromUrl('https://example.com/a%20b.jpg')).toBe('a b.jpg');
    expect(filenameFromUrl('https://example.com/noext')).toBe('image.png');
  });

  it('falls back to the provided name when no filename can be derived', () => {
    expect(filenameFromUrl('data:;base64,AAA', 'fallback.gif')).toBe('fallback.gif');
  });

  it('downloads a data URL via an anchor with the download attribute', () => {
    const { click } = mockAnchorClick();
    downloadUrl('data:image/png;base64,AAA', 'pic.png');
    expect(click).toHaveBeenCalledTimes(1);
  });
});
