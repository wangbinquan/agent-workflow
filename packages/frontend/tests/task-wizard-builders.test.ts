// LOCKS: RFC-165 T13 (§11.23) — the /tasks/new wizard's three body builders,
// the scratch space stamping, the scheduled-payload envelope and the inverse
// seed mapping. Every wire field is asserted EXPLICITLY (RFC-125 lesson:
// whitelist builders silently drop what nobody asserts).

import { describe, expect, test } from 'vitest'
import {
  buildAgentStartBody,
  buildScheduledEnvelope,
  buildWorkflowStartBody,
  buildWorkflowStartFormData,
  buildWorkgroupStartBody,
  defaultWizardSpace,
  payloadToWizardSeed,
  type WizardSpace,
} from '../src/lib/task-wizard'

const REMOTE: WizardSpace = {
  kind: 'remote',
  repos: [{ kind: 'url', repoUrl: 'https://github.com/o/r.git', ref: 'dev' }],
}
const MULTI: WizardSpace = {
  kind: 'remote',
  repos: [
    { kind: 'url', repoUrl: 'https://github.com/o/a.git', ref: '' },
    { kind: 'url', repoUrl: 'https://github.com/o/b.git', ref: 'v2' },
  ],
}
const SCRATCH: WizardSpace = { kind: 'scratch' }

describe('buildWorkflowStartBody (RFC-165 T13)', () => {
  test('remote single repo: every field lands', () => {
    const body = buildWorkflowStartBody(REMOTE, {
      workflowId: 'wf1',
      name: 'T',
      inputs: { k: 'v' },
      gitUserName: 'bot',
      gitUserEmail: 'bot@x.io',
      workingBranch: 'feat/x',
      autoCommitPush: true,
      collaboratorUserIds: ['u1'],
      maxDurationMs: 60_000,
      maxTotalTokens: 5000,
    })
    expect(body).toEqual({
      workflowId: 'wf1',
      name: 'T',
      inputs: { k: 'v' },
      repoUrl: 'https://github.com/o/r.git',
      ref: 'dev',
      gitUserName: 'bot',
      gitUserEmail: 'bot@x.io',
      workingBranch: 'feat/x',
      autoCommitPush: true,
      collaboratorUserIds: ['u1'],
      maxDurationMs: 60_000,
      maxTotalTokens: 5000,
    })
  })

  test('remote multi repo: repos[] shape, no top-level repoUrl', () => {
    const body = buildWorkflowStartBody(MULTI, { workflowId: 'wf1', name: 'T', inputs: {} })
    expect(body.repos).toEqual([
      { repoUrl: 'https://github.com/o/a.git' },
      { repoUrl: 'https://github.com/o/b.git', ref: 'v2' },
    ])
    expect(body.repoUrl).toBeUndefined()
  })

  test('scratch: scratch=true, NO repo fields, strips workingBranch/autoCommitPush', () => {
    const body = buildWorkflowStartBody(SCRATCH, {
      workflowId: 'wf1',
      name: 'T',
      inputs: { k: 'v' },
      gitUserName: 'bot',
      gitUserEmail: 'bot@x.io',
      // Lingering remote-mode state — the builder must strip these (schema
      // rejects them with scratch: true).
      workingBranch: 'feat/x',
      autoCommitPush: true,
      collaboratorUserIds: ['u1'],
      maxTotalTokens: 42,
    })
    expect(body).toEqual({
      workflowId: 'wf1',
      name: 'T',
      inputs: { k: 'v' },
      scratch: true,
      gitUserName: 'bot',
      gitUserEmail: 'bot@x.io',
      collaboratorUserIds: ['u1'],
      maxTotalTokens: 42,
    })
  })

  test('blank optionals stay off the wire', () => {
    const body = buildWorkflowStartBody(REMOTE, { workflowId: 'wf1', name: 'T', inputs: {} })
    expect(body).toEqual({
      workflowId: 'wf1',
      name: 'T',
      inputs: {},
      repoUrl: 'https://github.com/o/r.git',
      ref: 'dev',
    })
  })
})

describe('buildWorkflowStartFormData', () => {
  test('scratch + uploads: payload blob carries scratch body, upload keys padded', async () => {
    const fd = buildWorkflowStartFormData(
      SCRATCH,
      { workflowId: 'wf1', name: 'T', inputs: {} },
      { report: [new File(['x'], 'r.txt')] },
    )
    const blob = fd.get('payload') as Blob
    const body = JSON.parse(await blob.text()) as Record<string, unknown>
    expect(body.scratch).toBe(true)
    expect(body.repoUrl).toBeUndefined()
    expect(body.inputs).toEqual({ report: '' })
    expect(fd.getAll('files[report][]')).toHaveLength(1)
  })
})

describe('buildAgentStartBody', () => {
  test('remote: description + optionals; workflowId/inputs never leak', () => {
    const body = buildAgentStartBody(REMOTE, {
      name: 'T',
      description: 'fix the bug',
      allowClarify: true,
      gitUserName: 'bot',
      gitUserEmail: 'bot@x.io',
      workingBranch: 'feat/x',
      autoCommitPush: true,
      collaboratorUserIds: ['u1'],
      maxDurationMs: 1000,
      maxTotalTokens: 2000,
    })
    expect(body).toEqual({
      name: 'T',
      description: 'fix the bug',
      repoUrl: 'https://github.com/o/r.git',
      ref: 'dev',
      gitUserName: 'bot',
      gitUserEmail: 'bot@x.io',
      workingBranch: 'feat/x',
      autoCommitPush: true,
      collaboratorUserIds: ['u1'],
      maxDurationMs: 1000,
      maxTotalTokens: 2000,
    })
  })

  test('allowClarify: true (schema default) stays off the wire; false is stamped', () => {
    const on = buildAgentStartBody(SCRATCH, { name: 'T', description: 'd', allowClarify: true })
    expect('allowClarify' in on).toBe(false)
    const off = buildAgentStartBody(SCRATCH, { name: 'T', description: 'd', allowClarify: false })
    expect(off.allowClarify).toBe(false)
  })

  test('scratch: scratch=true and no branch/auto-push', () => {
    const body = buildAgentStartBody(SCRATCH, {
      name: 'T',
      description: 'd',
      allowClarify: true,
      workingBranch: 'x',
      autoCommitPush: true,
    })
    expect(body).toEqual({ name: 'T', description: 'd', scratch: true })
  })
})

describe('buildWorkgroupStartBody', () => {
  test('remote multi: goal + repos + limits land; workflowId/inputs never leak', () => {
    const body = buildWorkgroupStartBody(MULTI, {
      name: 'T',
      goal: 'ship it',
      collaboratorUserIds: ['u1', 'u2'],
      maxDurationMs: 5,
      maxTotalTokens: 6,
    })
    expect(body).toEqual({
      name: 'T',
      goal: 'ship it',
      repos: [
        { repoUrl: 'https://github.com/o/a.git' },
        { repoUrl: 'https://github.com/o/b.git', ref: 'v2' },
      ],
      collaboratorUserIds: ['u1', 'u2'],
      maxDurationMs: 5,
      maxTotalTokens: 6,
    })
  })

  test('scratch: scratch=true only', () => {
    const body = buildWorkgroupStartBody(SCRATCH, { name: 'T', goal: 'g' })
    expect(body).toEqual({ name: 'T', goal: 'g', scratch: true })
  })
})

describe('buildScheduledEnvelope (RFC-165 §9b)', () => {
  test('workflow: body passes through (workflowId is the discriminant)', () => {
    const body = { workflowId: 'wf1', name: 'T' }
    expect(buildScheduledEnvelope('workflow', body, {})).toEqual(body)
  })
  test('agent: agentName is injected', () => {
    expect(buildScheduledEnvelope('agent', { name: 'T' }, { agentName: 'auditor' })).toEqual({
      agentName: 'auditor',
      name: 'T',
    })
  })
  test('workgroup: workgroupName is injected', () => {
    expect(buildScheduledEnvelope('workgroup', { name: 'T' }, { workgroupName: 'core' })).toEqual({
      workgroupName: 'core',
      name: 'T',
    })
  })
})

describe('payloadToWizardSeed (editScheduled backfill)', () => {
  test('workflow payload round-trips through the builder', () => {
    const body = buildWorkflowStartBody(REMOTE, {
      workflowId: 'wf1',
      name: 'T',
      inputs: { k: 'v' },
      workingBranch: 'feat/x',
      autoCommitPush: true,
      maxDurationMs: 9,
    })
    const seed = payloadToWizardSeed('workflow', body)
    expect(seed).not.toBeNull()
    expect(seed?.workflowId).toBe('wf1')
    expect(seed?.taskName).toBe('T')
    expect(seed?.inputs).toEqual({ k: 'v' })
    expect(seed?.space).toEqual(REMOTE)
    expect(seed?.workingBranch).toBe('feat/x')
    expect(seed?.autoCommitPush).toBe(true)
    expect(seed?.maxDurationMs).toBe(9)
  })

  test('agent scratch payload round-trips (allowClarify=false preserved)', () => {
    const body = buildAgentStartBody(SCRATCH, { name: 'T', description: 'd', allowClarify: false })
    const seed = payloadToWizardSeed(
      'agent',
      buildScheduledEnvelope('agent', body, { agentName: 'a1' }),
    )
    expect(seed?.agentName).toBe('a1')
    expect(seed?.description).toBe('d')
    expect(seed?.allowClarify).toBe(false)
    expect(seed?.space).toEqual({ kind: 'scratch' })
  })

  test('workgroup payload round-trips', () => {
    const body = buildWorkgroupStartBody(REMOTE, { name: 'T', goal: 'g', maxTotalTokens: 7 })
    const seed = payloadToWizardSeed(
      'workgroup',
      buildScheduledEnvelope('workgroup', body, { workgroupName: 'core' }),
    )
    expect(seed?.workgroupName).toBe('core')
    expect(seed?.goal).toBe('g')
    expect(seed?.maxTotalTokens).toBe(7)
    expect(seed?.space).toEqual(REMOTE)
  })

  test('missing discriminant → null (degraded/legacy row renders blank for repair)', () => {
    expect(payloadToWizardSeed('workflow', { name: 'T' })).toBeNull()
    expect(payloadToWizardSeed('agent', { name: 'T', description: 'd' })).toBeNull()
    expect(payloadToWizardSeed('workgroup', { name: 'T', goal: 'g' })).toBeNull()
  })

  test('legacy path-only payload degrades to one blank URL row', () => {
    const seed = payloadToWizardSeed('workflow', { workflowId: 'wf1', name: 'T', repoPath: '/x' })
    expect(seed?.space).toEqual(defaultWizardSpace('remote'))
  })
})
