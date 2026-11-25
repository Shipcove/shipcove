import { describe, expect, it } from 'vitest';
import { relayedBody } from './llm-proxy.controller.js';

describe('proxy LLM : paramètres relayés', () => {
  it('garde les paramètres OpenAI et de raisonnement', () => {
    const { body, dropped } = relayedBody({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
      max_completion_tokens: 10,
      tools: [],
      tool_choice: 'auto',
      reasoning_effort: 'high',
      store: false,
    });
    expect(Object.keys(body).sort()).toEqual(['max_completion_tokens', 'messages', 'model', 'reasoning_effort', 'store', 'stream', 'tool_choice', 'tools']);
    expect(dropped).toEqual([]);
  });

  it('retire les options propres à LiteLLM (autre modèle, autre fournisseur, autre coût)', () => {
    const { body, dropped } = relayedBody({
      model: 'm',
      messages: [],
      fallbacks: ['modele-interdit'],
      context_window_fallback_dict: { m: 'modele-interdit' },
      api_base: 'http://ailleurs',
      api_key: 'k',
      mock_response: 'gratuit',
      metadata: { cap_request_id: 'falsifié' },
      stream_options: { include_usage: false },
      service_tier: 'priority',
    });
    expect(Object.keys(body).sort()).toEqual(['messages', 'model']);
    expect(dropped.sort()).toEqual(['api_base', 'api_key', 'context_window_fallback_dict', 'fallbacks', 'metadata', 'mock_response', 'service_tier']);
  });
});
