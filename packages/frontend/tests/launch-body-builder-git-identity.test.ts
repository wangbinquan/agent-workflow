// RFC-320 — launch builders never accept or emit a caller-selected Git
// identity. The server resolves the authenticated creator profile instead.

import { describe, expect, test } from 'vitest'
import { buildLaunchBody, type RepoSource } from '@/lib/launch-repo-source'

const SOURCE: RepoSource = {
  kind: 'url',
  repoUrl: 'git@github.com:base/repo.git',
  ref: 'main',
}

describe('buildLaunchBody RFC-320 account-owned Git identity', () => {
  test('ordinary launch body contains neither retired key', () => {
    const body = buildLaunchBody(SOURCE, {
      workflowId: 'wf-1',
      name: 'fixture',
      inputs: { topic: 'a' },
    })
    expect('gitUserName' in body).toBe(false)
    expect('gitUserEmail' in body).toBe(false)
  })

  test('a legacy object crossing an untyped boundary is still stripped', () => {
    const legacy = {
      workflowId: 'wf-1',
      name: 'fixture',
      inputs: {},
      gitUserName: 'Forged User',
      gitUserEmail: 'forged@example.test',
    } as unknown as Parameters<typeof buildLaunchBody>[1]
    const body = buildLaunchBody(SOURCE, legacy)
    expect(body.repoUrl).toBe('git@github.com:base/repo.git')
    expect('gitUserName' in body).toBe(false)
    expect('gitUserEmail' in body).toBe(false)
  })
})
