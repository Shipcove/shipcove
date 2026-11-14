import { describe, expect, it } from 'vitest';
import { apiTarget, decideApi, decideRefUpdate, extractRunToken, gitRequest, parseReceivePack, receivePackRejection } from './forge-policy.js';

const RT = 'cap_rt_' + 'a'.repeat(32);
const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, '0') + s;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);

describe('jeton de run', () => {
  it('est trouvé dans les en-têtes de git, gh et glab', () => {
    expect(extractRunToken({ authorization: `token ${RT}` })).toBe(RT);
    expect(extractRunToken({ authorization: `Bearer ${RT}` })).toBe(RT);
    expect(extractRunToken({ authorization: `Basic ${Buffer.from(`x-access-token:${RT}`).toString('base64')}` })).toBe(RT);
    expect(extractRunToken({ 'private-token': RT })).toBe(RT);
    expect(extractRunToken({ authorization: 'Bearer ghp_realtoken' })).toBeNull();
    expect(extractRunToken({})).toBeNull();
  });
});

describe('git smart HTTP', () => {
  it('reconnaît les requêtes et le dépôt', () => {
    expect(gitRequest('/o/r.git/info/refs?service=git-receive-pack')).toEqual({ kind: 'refs', repo: 'o/r', service: 'git-receive-pack' });
    expect(gitRequest('/g/sub/r.git/git-upload-pack')).toEqual({ kind: 'upload-pack', repo: 'g/sub/r' });
    expect(gitRequest('/o/r/git-receive-pack')).toEqual({ kind: 'receive-pack', repo: 'o/r' });
    expect(gitRequest('/repos/o/r/pulls')).toBeNull();
  });

  it('lit les commandes de push, attend la suite si incomplètes', () => {
    const body = pkt(`${A} ${B} refs/heads/feature\0report-status side-band-64k agent=git/2\n`) + pkt(`${A} ${Z} refs/heads/old\n`) + '0000PACK...';
    expect(parseReceivePack(Buffer.from(body.slice(0, 30)))).toBeNull();
    const r = parseReceivePack(Buffer.from(body))!;
    expect(r.updates).toEqual([
      { oldSha: A, newSha: B, ref: 'refs/heads/feature' },
      { oldSha: A, newSha: Z, ref: 'refs/heads/old' },
    ]);
    expect(r.capabilities).toContain('report-status');
    expect(() => parseReceivePack(Buffer.from('zzzz'))).toThrow();
  });

  it('garde-fous : branche par défaut, protégée, suppression', () => {
    const facts = { defaultBranch: 'main', protectedBranches: new Set(['release']) };
    expect(decideRefUpdate({ oldSha: A, newSha: B, ref: 'refs/heads/feature' }, facts).allowed).toBe(true);
    expect(decideRefUpdate({ oldSha: Z, newSha: B, ref: 'refs/tags/v1' }, facts).allowed).toBe(true);
    expect(decideRefUpdate({ oldSha: A, newSha: B, ref: 'refs/heads/main' }, facts).allowed).toBe(false);
    expect(decideRefUpdate({ oldSha: A, newSha: B, ref: 'refs/heads/release' }, facts).allowed).toBe(false);
    expect(decideRefUpdate({ oldSha: A, newSha: Z, ref: 'refs/heads/feature' }, facts).allowed).toBe(false);
    expect(decideRefUpdate({ oldSha: A, newSha: B, ref: 'refs/notes/x' }, facts).allowed).toBe(false);
  });

  it('refus au format report-status, avec ou sans side-band', () => {
    const updates = [{ oldSha: A, newSha: B, ref: 'refs/heads/main' }];
    const plain = receivePackRejection(updates, new Map([['refs/heads/main', 'non']]), ['report-status']).toString();
    expect(plain).toBe(`${pkt('unpack ok\n')}${pkt('ng refs/heads/main non\n')}0000`);
    const sb = receivePackRejection(updates, new Map([['refs/heads/main', 'non']]), ['report-status', 'side-band-64k']);
    expect(sb.toString()).toContain('ng refs/heads/main non');
    expect(sb.subarray(sb.length - 4).toString()).toBe('0000');
  });
});

describe('API des forges', () => {
  it('localise l’API REST et GraphQL', () => {
    expect(apiTarget('github', 'api.github.com', '/repos/o/r?x=1')).toEqual({ kind: 'rest', path: '/repos/o/r' });
    expect(apiTarget('github', 'api.github.com', '/graphql')).toEqual({ kind: 'graphql' });
    expect(apiTarget('github', 'ghe.corp', '/api/v3/repos/o/r')).toEqual({ kind: 'rest', path: '/repos/o/r' });
    expect(apiTarget('gitlab', 'gitlab.com', '/api/v4/projects/1')).toEqual({ kind: 'rest', path: '/projects/1' });
    expect(apiTarget('gitlab', 'gitlab.com', '/o/r/-/merge_requests')).toBeNull();
  });

  it('GitHub : autonomie (PR, commentaires, CI) mais pas de fusion ni de réglages', () => {
    const ok = (m: string, p: string) => decideApi('github', m, p).allowed;
    expect(ok('POST', '/repos/o/r/pulls')).toBe(true);
    expect(ok('POST', '/repos/o/r/issues/3/comments')).toBe(true);
    expect(ok('POST', '/repos/o/r/actions/runs/9/rerun')).toBe(true);
    expect(ok('PATCH', '/repos/o/r/pulls/3')).toBe(true);
    expect(ok('GET', '/repos/o/r/actions/runs/9/logs')).toBe(true);
    expect(ok('PUT', '/repos/o/r/pulls/3/merge')).toBe(false);
    expect(ok('DELETE', '/repos/o/r/git/refs/heads/x')).toBe(false);
    expect(ok('DELETE', '/repos/o/r')).toBe(false);
    expect(ok('PATCH', '/repos/o/r')).toBe(false);
    expect(ok('PUT', '/repos/o/r/branches/main/protection')).toBe(false);
    expect(ok('POST', '/repos/o/r/keys')).toBe(false);
    expect(ok('PUT', '/repos/o/r/actions/secrets/X')).toBe(false);
    expect(ok('POST', '/user/keys')).toBe(false);
    expect(decideApi('github', 'PUT', '/repos/o/r/contents/a.txt').branchWrite).toEqual({ repo: 'o/r' });
  });

  it('GitLab : MR et commentaires oui, fusion, suppression et accès durables non', () => {
    const ok = (m: string, p: string) => decideApi('gitlab', m, p).allowed;
    expect(ok('POST', '/projects/g%2Fr/merge_requests')).toBe(true);
    expect(ok('POST', '/projects/g%2Fr/merge_requests/2/notes')).toBe(true);
    expect(ok('POST', '/projects/g%2Fr/pipelines/5/retry')).toBe(true);
    expect(ok('PUT', '/projects/g%2Fr/merge_requests/2/merge')).toBe(false);
    expect(ok('DELETE', '/projects/g%2Fr/repository/branches/x')).toBe(false);
    expect(ok('DELETE', '/projects/g%2Fr')).toBe(false);
    expect(ok('POST', '/projects/g%2Fr/deploy_keys')).toBe(false);
    expect(ok('POST', '/user/personal_access_tokens')).toBe(false);
    expect(ok('POST', '/projects/g%2Fr/protected_branches')).toBe(false);
    expect(decideApi('gitlab', 'POST', '/projects/g%2Fr/repository/commits').branchWrite).toEqual({ repo: 'g/r' });
  });

  it('GraphQL : mutations dangereuses refusées, lectures et autres mutations admises', () => {
    expect(decideApi('github', 'POST', '/graphql', 'query { viewer { login } }').allowed).toBe(true);
    expect(decideApi('github', 'POST', '/graphql', 'mutation { addComment(input:{}) { clientMutationId } }').allowed).toBe(true);
    expect(decideApi('github', 'POST', '/graphql', 'mutation M { x: mergePullRequest(input:{}) { clientMutationId } }').allowed).toBe(false);
    expect(decideApi('github', 'POST', '/graphql', 'mutation { createCommitOnBranch(input:{}) { commit { oid } } }').allowed).toBe(false);
    expect(decideApi('gitlab', 'POST', '/graphql', 'mutation { mergeRequestAccept(input:{}) { errors } }').allowed).toBe(false);
  });
});
