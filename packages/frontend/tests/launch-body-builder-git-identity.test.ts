// RFC-067 — pure-function tests for buildLaunchBody's handling of the
// optional Git commit identity pair. Locks the wire contract that an
// HTTP body NEVER contains a half-set identity, regardless of source mode.

import { describe, expect, test } from 'vitest'
import { buildLaunchBody, type RepoSource } from '@/lib/launch-repo-source'

const SRC_A: RepoSource = { kind: 'url', repoUrl: 'git@github.com:base/repo.git', ref: 'main' }
const URL_SRC: RepoSource = { kind: 'url', repoUrl: 'git@github.com:foo/bar.git', ref: '' }

describe('buildLaunchBody RFC-067 git identity', () => {
  test('omitted → body has neither key', () => {
    const body = buildLaunchBody(SRC_A, {
      workflowId: 'wf-1',
      name: 'fixture',
      inputs: { topic: 'a' },
    })
    expect('gitUserName' in body).toBe(false)
    expect('gitUserEmail' in body).toBe(false)
  })

  test('both set → body carries both verbatim', () => {
    const body = buildLaunchBody(SRC_A, {
      workflowId: 'wf-1',
      name: 'fixture',
      inputs: {},
      gitUserName: 'AI Bot',
      gitUserEmail: 'bot@workflow.local',
    })
    expect(body.gitUserName).toBe('AI Bot')
    expect(body.gitUserEmail).toBe('bot@workflow.local')
  })

  test('only name set (caller bug) → helper drops both keys (defense in depth)', () => {
    const body = buildLaunchBody(SRC_A, {
      workflowId: 'wf-1',
      name: 'fixture',
      inputs: {},
      gitUserName: 'Lonely',
    })
    expect('gitUserName' in body).toBe(false)
    expect('gitUserEmail' in body).toBe(false)
  })

  test('only email set (caller bug) → helper drops both keys', () => {
    const body = buildLaunchBody(SRC_A, {
      workflowId: 'wf-1',
      name: 'fixture',
      inputs: {},
      gitUserEmail: 'lonely@local',
    })
    expect('gitUserName' in body).toBe(false)
    expect('gitUserEmail' in body).toBe(false)
  })

  test('empty strings on both → treated as omitted (no half-identity wire)', () => {
    const body = buildLaunchBody(SRC_A, {
      workflowId: 'wf-1',
      name: 'fixture',
      inputs: {},
      gitUserName: '',
      gitUserEmail: '',
    })
    expect('gitUserName' in body).toBe(false)
    expect('gitUserEmail' in body).toBe(false)
  })
})

describe('buildLaunchBody RFC-067 git identity (second fixture)', () => {
  test('both set → body carries both alongside repoUrl', () => {
    const body = buildLaunchBody(URL_SRC, {
      workflowId: 'wf-1',
      name: 'fixture',
      inputs: {},
      gitUserName: 'AI Bot',
      gitUserEmail: 'bot@workflow.local',
    })
    expect(body.repoUrl).toBe('git@github.com:foo/bar.git')
    expect(body.gitUserName).toBe('AI Bot')
    expect(body.gitUserEmail).toBe('bot@workflow.local')
  })

  test('half-set → helper drops both', () => {
    const body = buildLaunchBody(URL_SRC, {
      workflowId: 'wf-1',
      name: 'fixture',
      inputs: {},
      gitUserName: 'Lonely',
    })
    expect('gitUserName' in body).toBe(false)
    expect('gitUserEmail' in body).toBe(false)
  })
})
