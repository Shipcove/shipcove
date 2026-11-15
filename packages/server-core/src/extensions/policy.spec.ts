import { describe, expect, it } from 'vitest';
import { effectiveToolPermission, type PermissionRule } from './policy.js';

const s = { userId: 'u1' };
const r = (x: Partial<PermissionRule>): PermissionRule => ({ serverId: 'srv', toolName: '*', scope: 'global', subjectId: null, effect: 'allow', ...x });

describe('politique MCP par outil', () => {
  it('autorise par défaut', () => expect(effectiveToolPermission('srv', 'a', [], s)).toBe('allowed'));
  it('un deny global ne peut pas être levé par une portée inférieure', () => {
    const rules = [r({ effect: 'deny', toolName: 'a' }), r({ scope: 'personal', subjectId: 'u1', toolName: 'a' })];
    expect(effectiveToolPermission('srv', 'a', rules, s)).toBe('denied');
  });
  it('une portée inférieure peut restreindre', () => {
    expect(effectiveToolPermission('srv', 'b', [r({ scope: 'personal', subjectId: 'u1', effect: 'deny', toolName: 'b' })], s)).toBe('denied');
    expect(effectiveToolPermission('srv', 'b', [r({ scope: 'personal', subjectId: 'u2', effect: 'deny', toolName: 'b' })], s)).toBe('allowed');
  });
  it('liste blanche de la portée la plus haute', () => {
    const rules = [r({ toolName: 'a' }), r({ scope: 'personal', subjectId: 'u1', toolName: 'b' })];
    expect(effectiveToolPermission('srv', 'a', rules, s)).toBe('allowed');
    expect(effectiveToolPermission('srv', 'b', rules, s)).toBe('denied');
  });
});
