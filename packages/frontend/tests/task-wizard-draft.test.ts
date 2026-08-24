// RFC-250 T11/T12 — the task wizard recovery envelope is deliberately
// session-scoped, identity-bound and fail-closed around credentials. These
// tests lock the pure boundary before the route starts persisting user input.

import { describe, expect, test } from 'vitest'
import type { WorkflowInput } from '@agent-workflow/shared'
import {
  TASK_WIZARD_DRAFT_MAX_BYTES,
  TASK_WIZARD_DRAFT_TTL_MS,
  clearAllTaskWizardDrafts,
  parseTaskWizardDraft,
  serializeWizardInputs,
  serializeWizardSpace,
  taskWizardBaselineFingerprint,
  taskWizardDraftKey,
  taskWizardNewDraftSourceId,
  writeTaskWizardDraft,
  type TaskWizardDraftV1,
} from '../src/lib/task-wizard-draft'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() {
    return this.values.size
  }
  clear() {
    this.values.clear()
  }
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

function draft(overrides: Partial<TaskWizardDraftV1> = {}): TaskWizardDraftV1 {
  return {
    schemaVersion: 1,
    actorId: 'actor-1',
    flow: 'new',
    sourceId: null,
    savedAt: 10_000,
    baselineFingerprint: `sha256:${'0'.repeat(64)}`,
    step: 2,
    values: {
      kind: 'agent',
      workflowId: '',
      agentId: 'agent-1',
      workgroupId: '',
      space: { kind: 'scratch' },
      taskName: 'Diagnose race',
      inputs: {},
      uploadMetadata: {},
      description: 'Keep this expensive prompt',
      goal: '',
      allowClarify: false,
      collaboratorIds: ['user-2'],
      workingBranch: '',
      autoCommitPush: false,
    },
    ...overrides,
  }
}

describe('RFC-250 task wizard draft boundary', () => {
  test('key is identity-bound without embedding names, URLs or prompt text', () => {
    const key = taskWizardDraftKey({ actorId: 'actor-1', flow: 'relaunch', sourceId: 'task-9' })
    expect(key).toBe('aw:task-wizard-draft:v1:actor-1:relaunch:task-9')
    expect(key).not.toContain('https://')
  })

  test('new/deep-link source ids isolate resource, revision and schedule without exposing ids', () => {
    const picker = taskWizardNewDraftSourceId({
      scheduled: false,
      entry: { kind: 'picker', preferredKind: 'agent' },
    })
    const agent = taskWizardNewDraftSourceId({
      scheduled: false,
      entry: { kind: 'agent', resourceId: 'agent-1:https://alice:token@example.test' },
    })
    const scheduledAgent = taskWizardNewDraftSourceId({
      scheduled: true,
      entry: { kind: 'agent', resourceId: 'agent-1:https://alice:token@example.test' },
    })
    const workflowV1 = taskWizardNewDraftSourceId({
      scheduled: false,
      entry: { kind: 'workflow', resourceId: 'resource-1', workflowVersion: 1 },
    })
    const workflowV2 = taskWizardNewDraftSourceId({
      scheduled: false,
      entry: { kind: 'workflow', resourceId: 'resource-1', workflowVersion: 2 },
    })
    const workgroupV1 = taskWizardNewDraftSourceId({
      scheduled: false,
      entry: { kind: 'workgroup', resourceId: 'resource-1', workgroupVersion: 1 },
    })

    expect(picker).toMatch(/^new:immediate:picker:sha256:[0-9a-f]{64}$/)
    expect(agent).toMatch(/^new:immediate:agent:sha256:[0-9a-f]{64}$/)
    expect(
      new Set([picker, agent, scheduledAgent, workflowV1, workflowV2, workgroupV1]),
    ).toHaveProperty('size', 6)
    expect(agent).toBe(
      taskWizardNewDraftSourceId({
        scheduled: false,
        entry: { kind: 'agent', resourceId: 'agent-1:https://alice:token@example.test' },
      }),
    )
    expect(agent).not.toContain('agent-1')
    expect(agent).not.toContain('alice')
    expect(agent).not.toContain('token')
  })

  test('strict read accepts only the matching, fresh actor/flow/source envelope', () => {
    const storage = new MemoryStorage()
    const key = taskWizardDraftKey({ actorId: 'actor-1', flow: 'new', sourceId: null })
    expect(writeTaskWizardDraft(storage, key, draft())).toEqual({ ok: true })

    expect(
      parseTaskWizardDraft(storage.getItem(key), {
        actorId: 'actor-1',
        flow: 'new',
        sourceId: null,
        now: 10_000 + TASK_WIZARD_DRAFT_TTL_MS - 1,
      }),
    ).toMatchObject({ kind: 'ok', draft: { actorId: 'actor-1' } })
    expect(
      parseTaskWizardDraft(storage.getItem(key), {
        actorId: 'actor-2',
        flow: 'new',
        sourceId: null,
        now: 11_000,
      }),
    ).toEqual({ kind: 'identity-mismatch' })
    expect(
      parseTaskWizardDraft(storage.getItem(key), {
        actorId: 'actor-1',
        flow: 'new',
        sourceId: null,
        now: 10_000 + TASK_WIZARD_DRAFT_TTL_MS + 1,
      }),
    ).toEqual({ kind: 'expired' })
  })

  test('unknown versions, malformed records and oversized payloads fail closed', () => {
    expect(
      parseTaskWizardDraft('{"schemaVersion":2}', {
        actorId: 'actor-1',
        flow: 'new',
        sourceId: null,
        now: 11_000,
      }),
    ).toEqual({ kind: 'invalid' })
    expect(
      parseTaskWizardDraft('{broken', {
        actorId: 'actor-1',
        flow: 'new',
        sourceId: null,
        now: 11_000,
      }),
    ).toEqual({ kind: 'invalid' })
    expect(
      parseTaskWizardDraft(JSON.stringify(draft({ baselineFingerprint: 'raw-secret-material' })), {
        actorId: 'actor-1',
        flow: 'new',
        sourceId: null,
        now: 11_000,
      }),
    ).toEqual({ kind: 'invalid' })
    expect(
      parseTaskWizardDraft('x'.repeat(TASK_WIZARD_DRAFT_MAX_BYTES + 1), {
        actorId: 'actor-1',
        flow: 'new',
        sourceId: null,
        now: 11_000,
      }),
    ).toEqual({ kind: 'oversize' })
  })

  test('credentialed/manual URLs and unknown-sensitive inputs never enter JSON', () => {
    const secretUrl = 'https://alice:token@host.example/repo.git?access_token=abc#private'
    const malformedSecretUrl = 'mallory:ULTRA-SECRET@host.example:repo.git'
    const space = serializeWizardSpace({
      kind: 'remote',
      repos: [
        { kind: 'url', repoUrl: secretUrl, ref: 'main' },
        { kind: 'url', repoUrl: malformedSecretUrl, ref: 'release' },
      ],
    })
    const defs: WorkflowInput[] = [
      { kind: 'text', key: 'secretish', label: 'Secret-ish' },
      { kind: 'text', key: 'public', label: 'Public', sensitive: false },
      { kind: 'enum', key: 'mode', label: 'Mode', choices: ['fast', 'safe'] },
      {
        kind: 'enum',
        key: 'secretMode',
        label: 'Secret mode',
        choices: ['classified', 'safe'],
        secret: true,
      } as WorkflowInput,
    ]
    const inputs = serializeWizardInputs(
      {
        secretish: 'TOP-SECRET',
        public: 'safe text',
        mode: 'fast',
        secretMode: 'classified',
      },
      defs,
    )
    const raw = JSON.stringify({ space, inputs })

    expect(raw).not.toContain('alice')
    expect(raw).not.toContain('token')
    expect(raw).not.toContain('abc')
    expect(raw).not.toContain('private')
    expect(raw).not.toContain('mallory')
    expect(raw).not.toContain('ULTRA-SECRET')
    expect(raw).not.toContain('TOP-SECRET')
    expect(space).toMatchObject({
      kind: 'remote',
      repos: [
        { requiresRepoUrlReentry: true, ref: 'main' },
        { repoUrlRedacted: '', requiresRepoUrlReentry: true, ref: 'release' },
      ],
    })
    expect(inputs).toEqual({
      secretish: { kind: 'reentry-required' },
      public: { kind: 'value', value: 'safe text' },
      mode: { kind: 'value', value: 'fast' },
      secretMode: { kind: 'reentry-required' },
    })
  })

  test('baseline fingerprint is a fixed SHA-256 digest of sanitized values, never raw material', () => {
    const values = draft().values
    const fingerprint = taskWizardBaselineFingerprint(values)

    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(fingerprint).not.toContain(values.description)
    expect(fingerprint).toBe(taskWizardBaselineFingerprint(structuredClone(values)))
  })

  test('safe cached/scratch/group/replay spaces round-trip as allowlisted metadata', () => {
    expect(
      serializeWizardSpace({
        kind: 'remote',
        repos: [
          {
            kind: 'url',
            repoUrl: 'https://host.example/repo.git',
            cachedRepoId: 'cache-1',
            ref: 'main',
          },
        ],
      }),
    ).toEqual({
      kind: 'remote',
      repos: [
        {
          repoUrlRedacted: 'https://host.example/repo.git',
          cachedRepoId: 'cache-1',
          ref: 'main',
          requiresRepoUrlReentry: false,
        },
      ],
    })
    expect(serializeWizardSpace({ kind: 'scratch' })).toEqual({ kind: 'scratch' })
    expect(serializeWizardSpace({ kind: 'group', groupId: 'group-1' })).toEqual({
      kind: 'group',
      groupId: 'group-1',
    })
    expect(serializeWizardSpace({ kind: 'replay', sourceTaskId: 'task-1' })).toEqual({
      kind: 'replay',
      sourceTaskId: 'task-1',
    })
  })

  test('storage quota failures are visible to the caller and never truncate input', () => {
    const storage = new MemoryStorage()
    storage.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError')
    }
    const result = writeTaskWizardDraft(storage, 'draft', draft())
    expect(result).toMatchObject({ ok: false, reason: 'storage' })

    const tooLarge = draft({
      values: { ...draft().values, description: 'x'.repeat(TASK_WIZARD_DRAFT_MAX_BYTES) },
    })
    expect(writeTaskWizardDraft(new MemoryStorage(), 'draft', tooLarge)).toEqual({
      ok: false,
      reason: 'oversize',
    })
  })

  test('workflow drafts require the exact normalized workflow revision', () => {
    const legacyWorkflowDraft = draft({
      values: {
        ...draft().values,
        kind: 'workflow',
        workflowId: 'workflow-1',
        agentId: '',
      },
    })
    expect(
      parseTaskWizardDraft(JSON.stringify(legacyWorkflowDraft), {
        actorId: 'actor-1',
        flow: 'new',
        sourceId: null,
        now: 10_001,
      }),
    ).toEqual({ kind: 'invalid' })

    const fenced = {
      ...legacyWorkflowDraft,
      values: { ...legacyWorkflowDraft.values, selectedWorkflowVersion: 7 },
    }
    expect(
      parseTaskWizardDraft(JSON.stringify(fenced), {
        actorId: 'actor-1',
        flow: 'new',
        sourceId: null,
        now: 10_001,
      }),
    ).toMatchObject({
      kind: 'ok',
      draft: { values: { selectedWorkflowVersion: 7 } },
    })
  })

  test('a non-secret reconciliation marker survives reload but malformed markers fail closed', () => {
    const marked = draft({
      reconciliation: {
        operation: 'create-task',
        startedAt: 12_000,
        taskName: 'Diagnose race',
      },
    })
    expect(
      parseTaskWizardDraft(JSON.stringify(marked), {
        actorId: 'actor-1',
        flow: 'new',
        sourceId: null,
        now: 13_000,
      }),
    ).toMatchObject({
      kind: 'ok',
      draft: { reconciliation: { operation: 'create-task', startedAt: 12_000 } },
    })
    expect(
      parseTaskWizardDraft(
        JSON.stringify({ ...marked, reconciliation: { operation: 'create-task', taskName: 'x' } }),
        { actorId: 'actor-1', flow: 'new', sourceId: null, now: 13_000 },
      ),
    ).toEqual({ kind: 'invalid' })

    expect(
      parseTaskWizardDraft(
        JSON.stringify({
          ...marked,
          reconciliation: {
            operation: 'create-scheduled-task',
            startedAt: 12_500,
            taskName: 'Scheduled race',
          },
        }),
        { actorId: 'actor-1', flow: 'new', sourceId: null, now: 13_000 },
      ),
    ).toMatchObject({
      kind: 'ok',
      draft: { reconciliation: { operation: 'create-scheduled-task', startedAt: 12_500 } },
    })
  })

  test('logout cleanup removes only the task-wizard namespace', () => {
    const storage = new MemoryStorage()
    storage.setItem('aw:task-wizard-draft:v1:a:new:_', '{}')
    storage.setItem('aw:task-wizard-draft:v1:b:tour:first-task', '{}')
    storage.setItem('unrelated', 'keep')
    clearAllTaskWizardDrafts(storage)
    expect(storage.length).toBe(1)
    expect(storage.getItem('unrelated')).toBe('keep')
  })
})
