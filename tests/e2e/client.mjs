// Client HTTP minimal pour les tests e2e : cookies, CSRF, SSE.
import { generate } from 'otplib';

export const BASE = process.env.CAP_E2E_URL ?? 'http://127.0.0.1:8080';
export const ADMIN = { email: process.env.CAP_ADMIN_EMAIL ?? 'admin@example.test', password: process.env.CAP_ADMIN_PASSWORD ?? 'Admin-Password-123!' };

export class Client {
  cookies = new Map();
  get csrf() {
    return this.cookies.get('cap_csrf') ?? '';
  }
  async req(method, path, body, headers = {}) {
    const res = await fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-CSRF-Token': this.csrf } : {}),
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies.set(kv.slice(0, i), decodeURIComponent(kv.slice(i + 1)));
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }
  get(p) {
    return this.req('GET', p);
  }
  post(p, b = {}, h) {
    return this.req('POST', p, b, h);
  }
  put(p, b = {}, h) {
    return this.req('PUT', p, b, h);
  }
  patch(p, b = {}) {
    return this.req('PATCH', p, b);
  }
  del(p) {
    return this.req('DELETE', p);
  }

  /** Lit le flux SSE jusqu'à ce que `until(event)` soit vrai. */
  async events(workspaceId, fromId, until, timeoutMs = 300_000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const seen = [];
    try {
      const res = await fetch(`${BASE}/api/v1/workspaces/${workspaceId}/events?lastEventId=${fromId}`, {
        headers: { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data) continue;
          const e = JSON.parse(data);
          seen.push(e);
          if (until(e, seen)) return seen;
        }
      }
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
    throw new Error(`Flux terminé sans condition atteinte (${seen.map((e) => e.type).join(',')})`);
  }
}

/** Connexion admin, avec enrôlement TOTP si la politique l'impose (secret mémorisé pour la suite). */
export async function adminClient(state) {
  const c = new Client();
  const r = await c.post('/auth/login', { login: ADMIN.email, password: ADMIN.password });
  if (r.body?.status === 'mfa_enrollment_required') {
    const e = await c.post('/auth/mfa/totp/enroll');
    state.totp = e.body.secret;
    const ok = await c.post('/auth/mfa/totp/confirm', { code: await generate({ secret: state.totp }) });
    if (ok.status !== 200) throw new Error(`MFA confirm ${JSON.stringify(ok.body)}`);
  } else if (r.body?.status === 'mfa_required') {
    if (!state.totp) throw new Error('Secret TOTP admin inconnu : réinitialisez la base de test');
    // Anti-rejeu : un code déjà consommé (exécution précédente < 1 min) est refusé ;
    // on essaie les fenêtres acceptées (courante, suivante, précédente), puis on attend la suivante.
    let v;
    for (let attempt = 0; attempt < 2 && v?.body?.status !== 'authenticated'; attempt++) {
      if (attempt) await new Promise((res) => setTimeout(res, 30_000));
      for (const shift of [0, 30, -30]) {
        v = await c.post('/auth/mfa/verify', { code: await generate({ secret: state.totp, epoch: Math.floor(Date.now() / 1000) + shift }) });
        if (v.body?.status === 'authenticated') break;
      }
    }
    if (v.body?.status !== 'authenticated') throw new Error(`MFA ${JSON.stringify(v.body)}`);
  } else if (r.body?.status !== 'authenticated') {
    throw new Error(`Login admin : ${r.status} ${JSON.stringify(r.body)}`);
  }
  return c;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uid = () => Math.random().toString(36).slice(2, 8);
