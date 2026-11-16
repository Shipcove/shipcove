import { describe, expect, it } from 'vitest';
import { parseRemoteUrl } from './remote-url.js';

describe('parseRemoteUrl', () => {
  it.each([
    ['https://github.com/acme/app.git', 'github.com', 'acme/app'],
    ['https://github.com/acme/app', 'github.com', 'acme/app'],
    ['https://x-access-token:secret@github.com/acme/app.git', 'github.com', 'acme/app'],
    ['git@github.com:acme/app.git', 'github.com', 'acme/app'],
    ['ssh://git@gitlab.example.com:2222/group/sub/project.git', 'gitlab.example.com:2222', 'group/sub/project'],
    ['https://GitLab.Example.com/group/project/', 'gitlab.example.com', 'group/project'],
  ])('%s', (url, host, fullName) => {
    expect(parseRemoteUrl(url)).toEqual({ host, fullName });
  });

  it.each(['/srv/repo.git', '../autre', 'file:///srv/repo.git', 'https://github.com/seul', 'https://github.com/a/../b', 'pas une url'])('refuse %s', (url) => {
    expect(parseRemoteUrl(url)).toBeNull();
  });
});
