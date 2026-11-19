import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, finish, forUi, initialState, resultText, schedule, stepSummary, TOOLS } from './subagent-core.ts';

const ev = (o: unknown) => JSON.stringify(o);

test('suit les étapes et le compte rendu d’un sous-agent', () => {
  const s = initialState('Cartographier l’API', 'explore');
  assert.equal(applyEvent(s, ev({ type: 'tool_execution_start', toolName: 'grep', args: { pattern: 'router.get' } })), true);
  assert.equal(s.steps[0].summary, 'router.get');
  applyEvent(s, ev({ type: 'tool_execution_end', toolName: 'grep', isError: false }));
  assert.equal(s.steps[0].status, 'completed');
  applyEvent(s, ev({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Trois routes.' }], usage: { totalTokens: 1200 } } }));
  assert.equal(s.output, 'Trois routes.');
  assert.equal(s.tokens, 1200);
  finish(s, 0, false, '');
  assert.equal(s.status, 'completed');
  assert.match(resultText([s]), /Sous-agent 1 — Cartographier l’API \(exploration, completed, 1 action\)\n\nTrois routes\./);
});

test('ignore les lignes illisibles et les messages qui ne sont pas de l’agent', () => {
  const s = initialState('x', 'work');
  assert.equal(applyEvent(s, 'pas du json'), false);
  assert.equal(applyEvent(s, ev({ type: 'message_end', message: { role: 'user', content: 'Task: x' } })), false);
  assert.equal(applyEvent(s, ''), false);
});

test('échec, interruption et sortie tronquée', () => {
  const failed = initialState('a', 'work');
  finish(failed, 1, false, 'ligne 1\nErreur fatale');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /Erreur fatale/);
  const aborted = initialState('b', 'work');
  applyEvent(aborted, ev({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'npm test' } }));
  finish(aborted, null, true, '');
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.steps[0].status, 'failed');
  const long = initialState('c', 'explore');
  long.output = 'x'.repeat(20_000);
  assert.ok(forUi([long]).agents[0].output.length < 13_000);
});

test('explorations en parallèle, travaux l’un après l’autre', () => {
  assert.deepEqual(schedule(['explore', 'explore']), [[0, 1]]);
  assert.deepEqual(schedule(['work', 'explore', 'work']), [[1, 0], [2]]);
  assert.deepEqual(schedule(['work']), [[0]]);
});

test('un explorateur n’a aucun outil d’écriture ni de commande', () => {
  assert.ok(!TOOLS.explore.includes('bash') && !TOOLS.explore.includes('write') && !TOOLS.explore.includes('edit'));
  assert.equal(stepSummary('bash', { command: 'npm test\nsuite' }), 'npm test');
});
