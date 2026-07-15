// RFC-192 (T1) — /tasks repo display name.
//
// URL-mode rows must derive from the REDACTED repoUrl (never expose the
// internal cache dir `{hash}-{slug}` as the repo name, never render raw
// credentials — Codex 设计门 P2 + RFC-024).

import { describe, expect, test } from 'vitest'
import { taskRepoDisplayName } from '../src/lib/task-repo-name'

describe('taskRepoDisplayName', () => {
  test('path mode: basename of repoPath (trailing slash / single segment / empty)', () => {
    expect(
      taskRepoDisplayName({ repoPath: '/Users/w/proj/agent-workflow', repoUrl: null }),
    ).toEqual({ name: 'agent-workflow', title: '/Users/w/proj/agent-workflow' })
    expect(taskRepoDisplayName({ repoPath: '/repo/', repoUrl: null }).name).toBe('repo')
    expect(taskRepoDisplayName({ repoPath: 'solo', repoUrl: null }).name).toBe('solo')
    expect(taskRepoDisplayName({ repoPath: '', repoUrl: null }).name).toBe('')
  })

  test('URL mode: repo name from the URL, .git stripped — NOT the cache dir', () => {
    const d = taskRepoDisplayName({
      repoPath: '/home/.agent-workflow/repos/deadbeef-agent-workflow',
      repoUrl: 'https://github.com/org/agent-workflow.git',
    })
    expect(d.name).toBe('agent-workflow')
    expect(d.name).not.toContain('deadbeef')
    expect(d.title).toBe('https://github.com/org/agent-workflow.git')
  })

  test('URL mode: credentials are redacted in the hover title (RFC-024)', () => {
    const d = taskRepoDisplayName({
      repoPath: '/cache/x',
      repoUrl: 'https://user:secret@github.com/org/private-repo.git',
    })
    expect(d.title).not.toContain('secret')
    expect(d.title).toContain('***@')
    expect(d.name).toBe('private-repo')
  })

  test('URL mode: scp-style ssh URLs resolve via the `:` separator', () => {
    expect(
      taskRepoDisplayName({ repoPath: '/cache/y', repoUrl: 'git@github.com:org/tools.git' }).name,
    ).toBe('tools')
  })

  test('unparsable URL falls back to the repoPath basename (never a blank cell)', () => {
    const d = taskRepoDisplayName({ repoPath: '/cache/deadbeef-slug', repoUrl: '////' })
    expect(d.name).toBe('deadbeef-slug')
  })
})
