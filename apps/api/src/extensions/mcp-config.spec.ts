import { describe, expect, it } from 'vitest';
import { effectiveToolPermission, type PermissionRule } from '@cap/server-core';
import { mergeSecrets, selectionRules, splitHeaders } from './mcp-config.js';

describe('configuration des serveurs MCP', () => {
  it('sépare en-têtes publics et secrets (cochés ou au nom sensible)', () => {
    const { pub, secret } = splitHeaders(
      { 'X-Atlassian-Jira-Url': 'https://jira.example', 'X-Atlassian-Jira-Personal-Token': 'pat', 'X-Tenant': 'a' },
      { 'X-Tenant': 'a' },
    );
    expect(pub).toEqual({ 'X-Atlassian-Jira-Url': 'https://jira.example' });
    expect(secret).toEqual({ 'X-Atlassian-Jira-Personal-Token': 'pat', 'X-Tenant': 'a' });
  });

  it('modification : remplace, conserve et retire les secrets', () => {
    const stored = { 'header:X-Token': 'ancien', 'header:X-Other': 'garde', API_KEY: 'k', 'header:X-Public': 'était secret' };
    const next = mergeSecrets(stored, {
      publicHeaders: { 'X-Public': 'désormais public' },
      secretHeaders: { 'X-Token': 'nouveau' },
      remove: ['API_KEY'],
    });
    expect(next).toEqual({ 'header:X-Token': 'nouveau', 'header:X-Other': 'garde' });
  });
});

describe('sélection des outils', () => {
  const tools = ['jira_search', 'jira_get_issue', 'jira_create_issue', 'jira_delete_issue'];
  const me = { userId: 'u1' };
  const perm = (rules: PermissionRule[]) => Object.fromEntries(tools.map((t) => [t, effectiveToolPermission('s1', t, rules, me)]));

  it('les outils décochés sont refusés, les autres restent autorisés (pas de liste blanche)', () => {
    const rules = selectionRules('s1', 'personal', 'u1', ['jira_delete_issue', 'jira_delete_issue']);
    expect(rules).toHaveLength(1);
    expect(perm(rules)).toEqual({ jira_search: 'allowed', jira_get_issue: 'allowed', jira_create_issue: 'allowed', jira_delete_issue: 'denied' });
  });

  it('un refus de l’administrateur l’emporte sur la sélection personnelle', () => {
    const global = selectionRules('s1', 'global', null, ['jira_create_issue']);
    const mine = selectionRules('s1', 'personal', 'u1', []);
    expect(perm([...global, ...mine]).jira_create_issue).toBe('denied');
    expect(perm([...global, ...mine]).jira_search).toBe('allowed');
  });

  it('« * » n’est jamais produit par une sélection', () => {
    expect(selectionRules('s1', 'personal', 'u1', ['*'])).toEqual([]);
  });
});
