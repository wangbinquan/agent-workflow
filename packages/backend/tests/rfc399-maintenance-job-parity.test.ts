// RFC-399 B1: lock pre-move counters, deltas and continuation semantics for the job
// handlers not dispatched by rfc338-maintenance-slices; invoke the real bootstrap handler table.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MaintenanceJobExecutionResult } from '@/platform/contracts/maintenanceJob'
import type { MaintenanceJobKey } from '@agent-workflow/shared'
import {
  composeMaintenanceJobBindings,
  type MaintenanceOwnerCommands,
} from '@/bootstrap/maintenanceJobBindings'
import { runMaintenanceJob } from '@/platform/background/maintenanceJobRunner'
import type {
  TaskRecoveryOperations,
  TaskLifecycleAlertReconciliation,
} from '@/modules/task-execution/application/ports/taskRecoveryOperations'

const unexpected = (): never => {
  throw new Error('unexpected maintenance command')
}
const taskRecovery = (selected: Partial<TaskRecoveryOperations>): TaskRecoveryOperations =>
  new Proxy(selected as TaskRecoveryOperations, {
    get: (target, key) => Reflect.get(target, key) ?? unexpected,
  })

function owners(): MaintenanceOwnerCommands {
  return {
    workspace: { runGcPhase: unexpected, recover: unexpected },
    developmentAutomation: { sweepExpiredUploads: unexpected, sweepRetention: unexpected },
    digitalEmployee: { sweepExpiredInputUploads: unexpected },
    atomicApply: { converge: unexpected },
    intent: {
      scratch: { sweep: unexpected },
      recovery: { bootTurnIds: unexpected, recover: unexpected },
    },
    pluginGenerationGc: { command: { run: unexpected }, executionFence: unexpected },
    integration: {
      gcWebhookDeliveries: unexpected,
      recoverInterruptedWebhookDeliveries: unexpected,
    },
    taskRecovery: taskRecovery({}),
    taskArchive: {
      runSweep: unexpected,
      preview: unexpected,
      runManual: unexpected,
      recover: unexpected,
    },
    tokenAudit: { pruneSlice: unexpected },
    system: {
      eventsArchive: { runSlice: unexpected },
      retention: { runSlice: unexpected },
      storage: { run: unexpected },
    },
  }
}
function run(
  commands: MaintenanceOwnerCommands,
  job: MaintenanceJobKey,
  payload: unknown,
  cursor?: unknown,
) {
  return runMaintenanceJob({
    handlers: composeMaintenanceJobBindings(commands),
    appHome: '/rfc399/home',
    job,
    payload,
    ...(cursor === undefined ? {} : { cursor }),
  })
}
const none = { kind: 'none' } as const

test('worktreeGc preserves five phase order, counters, cursor version and 25 ms continuation', async () => {
  const commands = owners()
  const calls: unknown[] = []
  const phases = ['worktree', 'iso', 'scratch', 'orphan', 'partial'] as const
  commands.workspace.runGcPhase = async (input) => {
    calls.push(input)
    return { scanned: 7, removed: 2, skipped: 5 }
  }
  let cursor: unknown
  for (const [i, phase] of phases.entries()) {
    const result = await run(
      commands,
      'worktreeGc',
      { worktreeAutoGc: { enabled: true }, activeTaskIds: ['active'] },
      cursor,
    )
    expect(calls[i]).toEqual({
      phase,
      activeTaskIds: ['active'],
      worktreeAutoGc: { enabled: true },
      gitCloneTimeoutMs: 0,
      now: expect.any(Number),
    })
    expect(result).toEqual({
      counters: { scanned: 7, removed: 2, skipped: 5 },
      delta: none,
      ...(i === 4
        ? {}
        : { continuation: { cursor: { version: 1, phase: phases[i + 1] }, resumeAfterMs: 25 } }),
    })
    cursor = result.continuation?.cursor
  }
  await expect(
    run(
      commands,
      'worktreeGc',
      { worktreeAutoGc: { enabled: true } },
      { version: 2, phase: 'iso' },
    ),
  ).rejects.toThrow('maintenance-worktree-gc-cursor-invalid')
  expect(calls).toHaveLength(5)
})

test('workspaceRecovery keeps active IDs, time and every recovery counter', async () => {
  const commands = owners()
  commands.workspace.recover = async (input) => {
    expect(input).toEqual({ activeTaskIds: ['task'], now: expect.any(Number) })
    return { completed: 2, failed: 3, skipped: 4, healed: 5 }
  }
  expect(await run(commands, 'workspaceRecovery', { activeTaskIds: ['task'] })).toEqual({
    counters: { completed: 2, failed: 3, skipped: 4, healed: 5 },
    delta: none,
  })
})

test('developmentRetentionSweep projects all owner counters without continuation', async () => {
  const commands = owners()
  commands.developmentAutomation.sweepRetention = async (now) => {
    expect(now).toEqual(expect.any(Number))
    return {
      missionsScanned: 7,
      prunedAttempts: 2,
      markedBundleRefs: 3,
      expiredBundleRefsPending: 4,
    }
  }
  expect(await run(commands, 'developmentRetentionSweep', {})).toEqual({
    counters: {
      missionsScanned: 7,
      prunedAttempts: 2,
      markedBundleRefs: 3,
      expiredBundleRefsPending: 4,
    },
    delta: none,
  })
})

test('taskArchive preserves path construction, tree/task counts and skipped count', async () => {
  const commands = owners()
  const payload = { enabled: true, retentionDays: 14, maxTreesPerSweep: 3 }
  commands.taskArchive.runSweep = async (config, options) => {
    expect(config).toEqual(payload)
    expect(options).toEqual({
      archiveDir: '/rfc399/home/archive/tasks',
      runsDir: '/rfc399/home/runs',
      logsDir: '/rfc399/home/logs',
    })
    return {
      archived: [
        { rootTaskId: 'root', taskIds: ['root', 'child'], rows: {}, dir: 'tree1' },
        { rootTaskId: 'other', taskIds: ['other'], rows: {}, dir: 'tree2' },
      ],
      skipped: 4,
    }
  }
  expect(await run(commands, 'taskArchive', payload)).toEqual({
    counters: { trees: 2, tasks: 3, skipped: 4 },
    delta: none,
  })
})

test('backupPrune passes provider retention settings and preserves its counters', async () => {
  const commands = owners()
  const payload = { retentionCount: 3, retentionDays: 7, maxTotalBytes: 100, protectedKeepCount: 1 }
  const selected = {
    ...commands,
    system: {
      ...commands.system,
      databaseBackups: {
        async prune(input: unknown) {
          expect(input).toEqual(payload)
          return { deleted: 2, kept: 3 }
        },
      },
    },
  }
  expect(await run(selected, 'backupPrune', payload)).toEqual({
    counters: { deleted: 2, kept: 3 },
    delta: none,
  })
})

// RFC-399 B1: the standalone fallback (no database backup maintenance) now lives in SO local
// infrastructure and is injected by SO composition; it must still prune `<appHome>/backups`.
test('backupPrune without database backups prunes the local backups directory', async () => {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc399-backup-prune-'))
  try {
    const backups = join(appHome, 'backups')
    mkdirSync(backups)
    const old = Date.now() / 1000 - 30 * 86_400
    for (const [index, name] of [
      'scheduled-1.tar.gz',
      'scheduled-2.tar.gz',
      'scheduled-3.tar.gz',
    ].entries()) {
      writeFileSync(join(backups, name), 'x')
      utimesSync(join(backups, name), old + index, old + index)
    }
    const result = await runMaintenanceJob({
      handlers: composeMaintenanceJobBindings(owners()),
      appHome,
      job: 'backupPrune',
      payload: { retentionCount: 1, retentionDays: 7, maxTotalBytes: 0, protectedKeepCount: 0 },
    })
    expect(result).toEqual({ counters: { deleted: 2, kept: 1 }, delta: none })
    expect(existsSync(join(backups, 'scheduled-3.tar.gz'))).toBe(true)
    expect(existsSync(join(backups, 'scheduled-1.tar.gz'))).toBe(false)
    expect(existsSync(join(backups, 'scheduled-2.tar.gz'))).toBe(false)
  } finally {
    rmSync(appHome, { recursive: true, force: true })
  }
})

test('walCheckpoint preserves storage counters', async () => {
  const commands = owners()
  commands.system.storage.run = async () => ({ busy: 0, log: 9, checkpointed: 9 })
  expect(await run(commands, 'walCheckpoint', {})).toEqual({
    counters: { busy: 0, log: 9, checkpointed: 9 },
    delta: none,
  })
})

test('hostedObjectRecovery preserves selected owner counters and absent-owner skip', async () => {
  const commands = owners()
  expect(await run(commands, 'hostedObjectRecovery', {})).toEqual({
    counters: { skipped: 1 },
    delta: none,
  })
  expect(
    await run(
      {
        ...commands,
        system: { ...commands.system, objectPublications: { run: async () => ({ released: 4 }) } },
      },
      'hostedObjectRecovery',
      {},
    ),
  ).toEqual({ counters: { released: 4 }, delta: none })
})

test('intentScratchGc keeps retention hours and removed count', async () => {
  const commands = owners()
  commands.intent.scratch.sweep = async (input) => {
    expect(input).toEqual({ retentionHours: 48 })
    return { removed: 5 }
  }
  expect(await run(commands, 'intentScratchGc', { retentionHours: 48 })).toEqual({
    counters: { removed: 5 },
    delta: none,
  })
})

test('intentRecovery awaits owner recovery before AtomicApply and retains queued delta order', async () => {
  const commands = owners()
  const calls: string[] = []
  commands.intent.recovery.recover = async (input) => {
    expect(input).toEqual({ recoverTurnIds: ['turn'] })
    calls.push('recover')
    return {
      failed: 99,
      rolledForward: 98,
      queuedWorkingSets: 3,
      orphanedTurns: 4,
      queuedSessionIds: ['b', 'a'],
    }
  }
  commands.atomicApply.converge = async (active) => {
    expect(calls).toEqual(['recover'])
    calls.push('converge')
    expect(active).toEqual({ intent: ['intent'], 'resource-package': ['bundle'] })
    return { failed: 1, rolledForward: 2 }
  }
  expect(
    await run(commands, 'intentRecovery', {
      recoverTurnIds: ['turn'],
      activeIntentApplyJournalIds: ['intent'],
      activeBundleApplyIds: ['bundle'],
    }),
  ).toEqual({
    counters: { failed: 1, rolledForward: 2, queuedWorkingSets: 3, orphanedTurns: 4 },
    delta: { kind: 'intent-queued', sessionIds: ['b', 'a'] },
  })
  expect(calls).toEqual(['recover', 'converge'])
})

function reconciliation(): TaskLifecycleAlertReconciliation {
  const row = {
    id: 'alert',
    taskId: 'task',
    rule: 'T1',
    severity: 'warning' as const,
    detail: {},
    detectedAt: 11,
    resolvedAt: null,
  }
  return {
    newAlerts: 1,
    promotedAlerts: 0,
    resolvedAlerts: 1,
    openAlerts: [row],
    transitions: [{ row, kind: 'new' }],
    resolvedTaskIds: ['resolved'],
  }
}
const alertResult: MaintenanceJobExecutionResult = {
  counters: { scanned: 1, newAlerts: 1, promotedAlerts: 0, resolvedAlerts: 1, openAlerts: 1 },
  delta: {
    kind: 'lifecycle-alerts',
    alerts: [{ taskId: 'task', rule: 'T1', severity: 'warning', transition: 'new' }],
    resolvedTaskIds: ['resolved'],
  },
}

test('lifecycleInvariants retains alert projection and resolved task delta', async () => {
  const commands = owners()
  const selected = taskRecovery({
    loadLifecycleInvariantSnapshots: async (scope) => {
      expect(scope).toEqual({ taskId: 'task' })
      return [
        {
          taskId: 'task',
          taskStatus: 'awaiting_review',
          workflowSnapshot: '{"nodes":[]}',
          hasUndispatchedDesignerQuestions: false,
          documentVersions: [],
          clarifyRounds: [],
          nodeRuns: [],
        },
      ]
    },
    reconcileStuckAlerts: async (input) => {
      expect(input.taskIds).toEqual(['task'])
      return reconciliation()
    },
  })
  expect(
    await run({ ...commands, taskRecovery: selected }, 'lifecycleInvariants', {
      scope: { taskId: 'task' },
    }),
  ).toEqual(alertResult)
})

test('stuckTaskDetector retains alert projection and resolved task delta', async () => {
  const commands = owners()
  const selected = taskRecovery({
    loadStuckTaskSnapshots: async () => [
      {
        subject: { kind: 'workflow', sourceId: 'workflow' },
        taskId: 'task',
        parentTaskId: null,
        status: 'awaiting_review',
        startedAt: 1,
        ownerUserId: null,
        workgroupId: null,
        worktreePath: '',
        workspacePruningAt: null,
        workspacePrunedAt: null,
        hasRepoPrepRow: false,
        latestEventTs: null,
        hasPendingDocVersion: false,
        hasOpenClarifySession: false,
        hasUndispatchedDesignerQuestions: false,
        hasNoActiveHumanMember: false,
        workflowSnapshot: '{"nodes":[]}',
        runs: [],
      },
    ],
    reconcileStuckAlerts: async (input) => {
      expect(input.taskIds).toEqual(['task'])
      return reconciliation()
    },
  })
  expect(
    await run({ ...commands, taskRecovery: selected }, 'stuckTaskDetector', {
      stuckThresholdMs: 100,
      pendingThresholdMs: 200,
    }),
  ).toEqual(alertResult)
})

test('humanGateRecovery settles historical rows with the unchanged retired result', async () => {
  expect(await run(owners(), 'humanGateRecovery', {})).toEqual({
    counters: { retired: 1 },
    delta: none,
  })
})

// The existing slice tests exercise these providers directly. These cases lock
// only the moved handler's payload/result projection, not their database algorithms.
test('webhookDeliveryGc preserves cutoffs, phase cursor and counters at the handler boundary', async () => {
  const commands = owners()
  const cursor = { version: 1 as const, phase: 'bodies' as const, bodyCutoff: 11, rowCutoff: 22 }
  const next = { ...cursor, phase: 'rows' as const }
  commands.integration.gcWebhookDeliveries = async (input) => {
    expect(input).toEqual({
      now: expect.any(Number),
      retention: { bodyRetentionMs: 2 * 86_400_000, rowRetentionMs: 7 * 86_400_000 },
      cursor,
      batchSize: 1000,
    })
    return { done: false, cursor: next, counters: { bodiesCleared: 4, rowsDeleted: 0 } }
  }
  expect(
    await run(commands, 'webhookDeliveryGc', { bodyRetentionDays: 2, rowRetentionDays: 7 }, cursor),
  ).toEqual({
    counters: { bodiesCleared: 4, rowsDeleted: 0 },
    delta: none,
    continuation: { cursor: next, resumeAfterMs: 25 },
  })
})

test('retentionSweep forwards the durable cursor and returns the owner slice unchanged', async () => {
  const commands = owners()
  const cursor = { version: 1, phase: 'events', lastId: 'id' }
  const slice = {
    counters: { removed: 7 },
    delta: { kind: 'none' as const },
    continuation: { cursor: { version: 1, phase: 'webhooks' }, resumeAfterMs: 25 },
  }
  commands.system.retention.runSlice = async (input) => {
    expect(input).toEqual({
      eventStreamRetentionDays: 4,
      webhookTriggerFiresRetentionDays: 9,
      cursor,
    })
    return slice
  }
  expect(
    await run(
      commands,
      'retentionSweep',
      { eventStreamRetentionDays: 4, webhookTriggerFiresRetentionDays: 9 },
      cursor,
    ),
  ).toBe(slice)
})

for (const [job, cursorError] of [
  ['developmentUploadGc', 'maintenance-development-upload-cursor-invalid'],
  ['employeeInputGc', 'maintenance-employee-input-cursor-invalid'],
] as const) {
  test(`${job} continues only at the 1000-row boundary with the original cursor error`, async () => {
    const commands = owners()
    let calls = 0
    const sweep = async (now: number, batchSize?: number) => {
      expect(now).toEqual(expect.any(Number))
      expect(batchSize).toBe(1000)
      return calls++ === 0 ? 1000 : 3
    }
    commands.developmentAutomation.sweepExpiredUploads = sweep
    commands.digitalEmployee.sweepExpiredInputUploads = sweep
    expect(await run(commands, job, {})).toEqual({
      counters: { swept: 1000 },
      delta: none,
      continuation: { cursor: { version: 1 }, resumeAfterMs: 25 },
    })
    expect(await run(commands, job, {}, { version: 1 })).toEqual({
      counters: { swept: 3 },
      delta: none,
    })
    await expect(run(commands, job, {}, { version: 2 })).rejects.toThrow(cursorError)
    expect(calls).toBe(2)
  })
}

test('tokenAuditGc retains both counters and schedules only unfinished slices', async () => {
  const commands = owners()
  const cursor = { version: 1 as const, phase: 'audits' as const, cutoff: 17 }
  let done = false
  commands.tokenAudit.pruneSlice = async (days, received) => {
    expect(days).toBe(8)
    expect(received).toEqual(cursor)
    return { done, cursor, counters: { audits: 2, snapshots: 5 } }
  }
  expect(await run(commands, 'tokenAuditGc', { retentionDays: 8 }, cursor)).toEqual({
    counters: { audits: 2, snapshots: 5 },
    delta: none,
    continuation: { cursor, resumeAfterMs: 25 },
  })
  done = true
  expect(await run(commands, 'tokenAuditGc', { retentionDays: 8 }, cursor)).toEqual({
    counters: { audits: 2, snapshots: 5 },
    delta: none,
  })
})
