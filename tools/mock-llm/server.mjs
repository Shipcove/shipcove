#!/usr/bin/env node
// Fournisseur LLM factice, compatible OpenAI Chat Completions (streaming SSE + usage).
// RÉSERVÉ AUX TESTS : il ne génère aucun contenu « intelligent ».
//
// Scénario piloté par le dernier message utilisateur, via des directives :
//   [[tool:<nom> <json>]]   → l'étape i émet le i-ème appel d'outil
//   [[sleep:<ms>]]          → attend avant de répondre (tests d'interruption)
//   [[fail:<status>]]       → répond une erreur HTTP
// Une fois toutes les directives consommées (= autant de résultats d'outils reçus
// depuis le message utilisateur), le modèle répond par un texte final.
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 4010);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : (m.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      // Ignore les messages utilisateur synthétiques sans directives si un vrai prompt précède.
      return { index: i, text };
    }
  }
  return { index: -1, text: '' };
}

function plan(messages) {
  const { index, text } = lastUserIndex(messages);
  const directives = [...text.matchAll(/\[\[(tool|sleep|fail):([\s\S]*?)\]\]/g)].map((m) => ({ kind: m[1], arg: m[2].trim() }));
  const toolResults = messages.slice(index + 1).filter((m) => m.role === 'tool').length;
  const tools = directives.filter((d) => d.kind === 'tool');
  const sleepMs = directives.filter((d) => d.kind === 'sleep').reduce((a, d) => a + Number(d.arg), 0);
  const fail = directives.find((d) => d.kind === 'fail');
  if (toolResults < tools.length) {
    const d = tools[toolResults];
    const sp = d.arg.indexOf(' ');
    const name = sp === -1 ? d.arg : d.arg.slice(0, sp);
    const args = sp === -1 ? '{}' : d.arg.slice(sp + 1);
    return { type: 'tool', name, args, sleepMs, fail };
  }
  const echo = text.replace(/\[\[[\s\S]*?\]\]/g, '').trim();
  return { type: 'text', text: tools.length ? `Terminé : ${tools.length} action(s) exécutée(s).` : `Réponse factice : ${echo.slice(0, 200)}`, sleepMs, fail };
}

function countTokens(body) {
  return Math.max(1, Math.ceil(JSON.stringify(body.messages ?? []).length / 4));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
    return;
  }
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  const p = plan(body.messages ?? []);
  if (p.sleepMs) await sleep(p.sleepMs);
  if (p.fail) {
    res.writeHead(Number(p.fail.arg) || 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'échec simulé', type: 'mock_error' } }));
    return;
  }
  const id = `chatcmpl-mock-${Date.now()}`;
  const model = body.model ?? 'mock-model';
  const promptTokens = countTokens(body);
  const completionTokens = p.type === 'text' ? Math.ceil(p.text.length / 4) : Math.ceil(p.args.length / 4) + 5;
  const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, prompt_tokens_details: { cached_tokens: 0 } };
  const finish = p.type === 'tool' ? 'tool_calls' : 'stop';

  if (!body.stream) {
    const message = p.type === 'tool'
      ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${Date.now()}`, type: 'function', function: { name: p.name, arguments: p.args } }] }
      : { role: 'assistant', content: p.text };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: finish }], usage }));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  if (p.type === 'text') {
    for (const piece of p.text.match(/.{1,12}/gs) ?? []) {
      send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      await sleep(5);
    }
  } else {
    const callId = `call_${Date.now()}`;
    send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: p.name, arguments: '' } }] }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: p.args } }] }, finish_reason: null }] });
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  if (body.stream_options?.include_usage) send({ ...base, choices: [], usage });
  res.write('data: [DONE]\n\n');
  res.end();
});

server.listen(PORT, () => console.log(`mock-llm à l'écoute sur :${PORT}`));
