import type http from 'node:http';
import { describe, expect, it } from 'vitest';
import { sameOrigin } from './preview-proxy.service.js';

const req = (host: string, origin?: string) => ({ headers: { host, ...(origin !== undefined ? { origin } : {}) } }) as http.IncomingMessage;

describe('origine des requêtes de preview', () => {
  it('accepte la preview elle-même et les clients sans Origin', () => {
    expect(sameOrigin(req('w1-3000.preview.example.com', 'https://w1-3000.preview.example.com'))).toBe(true);
    expect(sameOrigin(req('w1-3000.preview.example.com'))).toBe(true);
  });

  it('refuse une autre preview du même site, ou une origine opaque', () => {
    expect(sameOrigin(req('w1-3000.preview.example.com', 'https://w2-3000.preview.example.com'))).toBe(false);
    expect(sameOrigin(req('w1-3000.preview.example.com', 'null'))).toBe(false);
    expect(sameOrigin(req('w1-3000.preview.example.com', 'pas une url'))).toBe(false);
  });
});
