// RFC-164 PR-4 → RFC-165 — buildWorkgroupStartBody field-by-field contract +
// the launch endpoint's 422-code → copy mapping.
//
// The explicit name/goal/repo assertions exist because of the RFC-125 lesson
// (launch body helpers whitelist fields — anything not asserted on the wire
// can be silently dropped by a refactor). The builder also must NOT leak the
// two workflow-launch-only keys (workflowId / inputs) it borrows from the
// shared repo-source builders.

import { describe, expect, test } from 'vitest'
import { ApiError } from '../src/api/client'
import {
  classifyWorkgroupLaunchError,
  workgroupLaunchErrorMessage,
} from '../src/lib/workgroup-launch'
import { buildWorkgroupStartBody, type WizardSpace } from '../src/lib/task-wizard'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'

describe('buildWorkgroupStartBody', () => {
  test('single url repo: exact minimal wire shape (name/goal/repoUrl)', () => {
    const body = buildWorkgroupStartBody(
      { kind: 'remote', repos: [{ kind: 'url', repoUrl: 'https://github.com/o/r.git', ref: '' }] },
      {
        name: 'audit run',
        goal: 'find the bugs',
      },
    )
    expect(body).toEqual({
      name: 'audit run',
      goal: 'find the bugs',
      repoUrl: 'https://github.com/o/r.git',
    })
    // Load-bearing single-field assertions (防静默丢字段).
    expect(body.name).toBe('audit run')
    expect(body.goal).toBe('find the bugs')
    expect(body.repoUrl).toBe('https://github.com/o/r.git')
    // Borrowed workflow-launch keys must be stripped.
    expect(body.workflowId).toBeUndefined()
    expect(body.inputs).toBeUndefined()
  })

  test('url repo: repoUrl + trimmed ref (empty ref omitted)', () => {
    const withRef = buildWorkgroupStartBody(
      {
        kind: 'remote',
        repos: [{ kind: 'url', repoUrl: 'https://github.com/o/r.git', ref: ' main ' }],
      },
      { name: 't', goal: 'g' },
    )
    expect(withRef.repoUrl).toBe('https://github.com/o/r.git')
    expect(withRef.ref).toBe('main')
    const noRef = buildWorkgroupStartBody(
      { kind: 'remote', repos: [{ kind: 'url', repoUrl: 'https://github.com/o/r.git', ref: '' }] },
      { name: 't', goal: 'g' },
    )
    expect(noRef.ref).toBeUndefined()
  })

  test('multi-repo: repos[] entries (RFC-165: url-only, no retired path keys)', () => {
    const body = buildWorkgroupStartBody(
      {
        kind: 'remote',
        repos: [
          { kind: 'url', repoUrl: 'https://github.com/o/a.git', ref: '' },
          { kind: 'url', repoUrl: 'https://github.com/o/r.git', ref: 'dev' },
        ],
      },
      { name: 't', goal: 'g' },
    )
    expect(body.repos).toEqual([
      { repoUrl: 'https://github.com/o/a.git' },
      { repoUrl: 'https://github.com/o/r.git', ref: 'dev' },
    ])
    expect(body.fetchBeforeLaunch).toBeUndefined()
    expect(body.repoPath).toBeUndefined()
    expect(body.repoUrl).toBeUndefined()
    expect(body.workflowId).toBeUndefined()
    expect(body.inputs).toBeUndefined()
  })

  test('optional extras ride the wire: collaborators / git identity / branch / push / limits', () => {
    const space: WizardSpace = {
      kind: 'remote',
      repos: [{ kind: 'url', repoUrl: 'https://x/r.git', ref: '' }],
    }
    const body = buildWorkgroupStartBody(space, {
      name: 't',
      goal: 'g',
      collaboratorUserIds: ['u1', 'u2'],
      gitUserName: 'Bot',
      gitUserEmail: 'bot@x.dev',
      workingBranch: 'feat/x',
      autoCommitPush: true,
      maxDurationMs: 600_000,
      maxTotalTokens: 42_000,
    })
    expect(body.collaboratorUserIds).toEqual(['u1', 'u2'])
    expect(body.gitUserName).toBe('Bot')
    expect(body.gitUserEmail).toBe('bot@x.dev')
    expect(body.workingBranch).toBe('feat/x')
    expect(body.autoCommitPush).toBe(true)
    expect(body.maxDurationMs).toBe(600_000)
    expect(body.maxTotalTokens).toBe(42_000)
  })

  test('omitted extras keep the wire minimal (no half-identity, no false flags)', () => {
    const body = buildWorkgroupStartBody(
      { kind: 'remote', repos: [{ kind: 'url', repoUrl: 'https://x/r.git', ref: '' }] },
      {
        name: 't',
        goal: 'g',
        autoCommitPush: false,
        collaboratorUserIds: [],
      },
    )
    expect(body.autoCommitPush).toBeUndefined()
    expect(body.collaboratorUserIds).toBeUndefined()
    expect(body.gitUserName).toBeUndefined()
    expect(body.maxDurationMs).toBeUndefined()
    expect(body.maxTotalTokens).toBeUndefined()
  })
})

describe('launch 422 mapping', () => {
  const echoT = (key: string) => key

  test('workgroup-not-ready carries the details.reasons through', () => {
    const err = new ApiError(422, 'workgroup-not-ready', 'not ready', {
      reasons: ['no-agent-member', 'leader-missing'],
    })
    expect(classifyWorkgroupLaunchError(err)).toEqual({
      kind: 'not-ready',
      reasons: ['no-agent-member', 'leader-missing'],
    })
    const msg = workgroupLaunchErrorMessage(err, echoT)
    expect(msg).toContain('workgroups.launch.notReady')
    expect(msg).toContain('workgroups.readiness.noAgentMember')
    expect(msg).toContain('workgroups.readiness.leaderMissing')
  })

  test('malformed details degrade to an empty reason list (never crash)', () => {
    const err = new ApiError(422, 'workgroup-not-ready', 'not ready', { reasons: 'bogus' })
    expect(classifyWorkgroupLaunchError(err)).toEqual({ kind: 'not-ready', reasons: [] })
  })

  test('workgroup-human-members-unsupported → the "later version" copy key', () => {
    const err = new ApiError(422, 'workgroup-human-members-unsupported', 'nope')
    expect(workgroupLaunchErrorMessage(err, echoT)).toBe(
      'workgroups.launch.humanMembersUnsupported',
    )
  })

  test('workgroup-launch-invalid → the invalid-payload copy key', () => {
    const err = new ApiError(422, 'workgroup-launch-invalid', 'bad payload')
    expect(workgroupLaunchErrorMessage(err, echoT)).toBe('workgroups.launch.invalidPayload')
  })

  test('unknown codes fall back to describeApiError (code: message shape survives)', () => {
    const err = new ApiError(500, 'boom', 'server exploded')
    const msg = workgroupLaunchErrorMessage(err, echoT)
    expect(msg).toContain('server exploded')
  })

  test('both bundles ship the three launch copies (and the unsupported copy promises a later version)', () => {
    for (const bundle of [zhCN, enUS]) {
      expect(bundle.workgroups.launchButton.length).toBeGreaterThan(0)
      expect(bundle.workgroups.launch.notReady.length).toBeGreaterThan(0)
      expect(bundle.workgroups.launch.invalidPayload.length).toBeGreaterThan(0)
      expect(bundle.workgroups.launch.humanMembersUnsupported.length).toBeGreaterThan(0)
    }
    expect(zhCN.workgroups.launch.humanMembersUnsupported).toContain('后续版本')
    expect(enUS.workgroups.launch.humanMembersUnsupported).toContain('later version')
  })
})
