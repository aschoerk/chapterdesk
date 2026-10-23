import { describe, it, expect, vi } from 'vitest';
import { filesToAttachments, MAX_ATTACHMENT_BYTES } from './attachments';

describe('filesToAttachments', () => {
  it('converts files into attachment records (base64 data-URL)', async () => {
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    const [a] = await filesToAttachments([file]);
    expect(a.name).toBe('hello.txt');
    expect(a.mimeType).toBe('text/plain');
    expect(a.size).toBe(5);
    expect(a.dataUrl).toMatch(/^data:text\/plain;base64,/);
    expect(a.id).toBeTruthy();
  });

  it('skips files over the size cap and reports them through onTooLarge', async () => {
    const big = new File([new ArrayBuffer(MAX_ATTACHMENT_BYTES + 1)], 'big.txt');
    const small = new File(['ok'], 'ok.txt');
    const onTooLarge = vi.fn();
    const arr = await filesToAttachments([big, small], { onTooLarge });
    expect(onTooLarge).toHaveBeenCalledWith('big.txt');
    expect(arr).toHaveLength(1);
    expect(arr[0].name).toBe('ok.txt');
  });

  it('honours a custom maxBytes option', async () => {
    const file = new File(['1234567890'], 'ten.txt');
    const arr = await filesToAttachments([file], { maxBytes: 4 });
    expect(arr).toHaveLength(0);
  });
});