import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeApp } from './helpers/app.js';
import {
  MOCK_MODEL_ID,
  MOCK_MODEL_NAME,
  buildChatReply,
  keyPhrases,
} from '../src/http/mock-llm.js';

let app: Express;

beforeAll(async () => {
  ({ app } = await makeApp());
});

describe('Mock LLM endpoints (key-free local provider)', () => {
  test('GET /models returns the mock writer catalog', async () => {
    const res = await request(app).get('/models');
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('list');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: MOCK_MODEL_ID,
      name: MOCK_MODEL_NAME,
    });
  });

  test('GET /images/models is an empty list', async () => {
    const res = await request(app).get('/images/models');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ object: 'list', data: [] });
  });

  test('POST /chat/completions returns a non-streaming OpenAI-style reply', async () => {
    const res = await request(app)
      .post('/chat/completions')
      .send({
        model: MOCK_MODEL_ID,
        messages: [
          { role: 'system', content: 'You write literary fiction.' },
          { role: 'user', content: 'Write the next chapter in the harbour village.' },
        ],
        stream: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('chat.completion');
    expect(res.body.choices?.[0]).toMatchObject({
      index: 0,
      message: { role: 'assistant' },
      finish_reason: 'stop',
    });
    const content: string = res.body.choices[0].message.content ?? '';
    expect(content.length).toBeGreaterThan(40);
    expect(res.body.usage).toMatchObject({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
      total_tokens: expect.any(Number),
    });
  });

  test('POST /chat/completions streams an SSE body when stream:true', async () => {
    const res = await request(app)
      .post('/chat/completions')
      .send({
        model: MOCK_MODEL_ID,
        messages: [{ role: 'user', content: 'Tell me what happens next.' }],
        stream: true,
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const text: string = res.text ?? '';
    expect(text).toContain('data:');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);

    // Reassemble the deltas — the assembled content must be non-trivial.
    const jsonBits = text
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => b.replace(/^data: /, ''))
      .filter((b) => b !== '[DONE]');
    let assembled = '';
    for (const bit of jsonBits) {
      const parsed = JSON.parse(bit);
      const delta = parsed.choices?.[0]?.delta ?? {};
      if (typeof delta.content === 'string') assembled += delta.content;
    }
    expect(assembled.trim().length).toBeGreaterThan(20);
    // A usage chunk was streamed before [DONE].
    const usageChunk = jsonBits.some((b) => {
      const p = JSON.parse(b);
      return Array.isArray(p.choices) && p.choices.length === 0 && !!p.usage;
    });
    expect(usageChunk).toBe(true);
  });
});

describe('buildChatReply (reply generator)', () => {
  test('produces prose for a writing direction', () => {
    const reply = buildChatReply(
      [{ role: 'user', content: 'The keeper finds a letter under the floorboards.' }],
      MOCK_MODEL_ID,
    );
    expect(reply.split('\n\n').length).toBeGreaterThanOrEqual(3);
    expect(reply.length).toBeGreaterThan(60);
  });

  test('produces a short title for a title request', () => {
    const reply = buildChatReply(
      [{ role: 'user', content: 'Generate a title for this story about a lighthouse.' }],
      MOCK_MODEL_ID,
    );
    expect(reply.length).toBeLessThan(120);
  });

  test('produces a JSON array for a chapter-headings request', () => {
    const reply = buildChatReply(
      [{ role: 'user', content: 'Return a JSON array with exactly 3 chapter headings.' }],
      MOCK_MODEL_ID,
    );
    expect(reply.trim().startsWith('[')).toBe(true);
    expect(reply.trim().endsWith(']')).toBe(true);
    expect((reply.match(/"/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  test('keyPhrases extracts distinct meaningful words', () => {
    const k = keyPhrases('The keeper finds a sealed letter under the floorboards');
    expect(k).toContain('keeper');
    expect(k).toContain('letter');
    expect(k).not.toContain('the');
  });
});