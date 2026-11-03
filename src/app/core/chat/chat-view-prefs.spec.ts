import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { ChatService } from './chat.service';

describe('ChatService.streamRevealPrefs — output speed gated by follow streaming', () => {
  let chat: ChatService;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ChatService,
        { provide: CHAT_API, useValue: new InMemoryChatApi() }
      ]
    });
    chat = TestBed.inject(ChatService);
    // A nonzero configured reveal speed (so the gating is observable).
    chat.setStreamSpeed(40);
    chat.setStreamSpeedUnit('char');
  });

  it('returns the configured speed (and pacing) when follow streaming is ON', () => {
    chat.setFollowStreaming(true);
    const prefs = chat.streamRevealPrefs();
    expect(prefs.streamSpeed()).toBe(40);
    expect(prefs.streamSpeedUnit()).toBe('char');
    expect(prefs.paceAfterComplete()).toBe(true);
  });

  it('forces an INSTANT reveal (speed 0) when follow streaming is OFF', () => {
    chat.setFollowStreaming(false);
    const prefs = chat.streamRevealPrefs();
    // The configured speed is still remembered, but the pump sees 0 (instant),
    // so a non-following user is never paced and can scroll freely.
    expect(chat.streamSpeed()).toBe(40);
    expect(prefs.streamSpeed()).toBe(0);
    expect(prefs.paceAfterComplete()).toBe(false);
  });
});