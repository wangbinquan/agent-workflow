// RFC-224 T20 regression lock — the runner is the durable ownership barrier:
// resume preclaims before the verified builder, control frames never become
// stderr events, and the exact lease remains held through post-run capture.

import type { Agent } from '@agent-workflow/shared'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  createRunnerOpencodeControlState,
  executionIdentityFailureCodeOf,
  processRunnerOpencodeControlLine,
  requiresVerifiedOpencodeBarrier,
  runNode,
} from '../src/services/runner'
import {
  getOpencodeSessionOwner,
  preclaimOpencodeSessionResume,
  releaseOpencodeSessionLease,
} from '../src/services/opencodeSessionOwner'
import {
  buildSessionReadyMarker,
  readControlAck,
} from '../src/services/runtime/opencode/controlProtocol'
import { ExecutionIdentityFailure } from '../src/services/runtime/opencode/failure'
import { opencodeDriver } from '../src/services/runtime/opencode/driver'
import { markProductionOpencodeCommand } from '../src/util/opencode'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const RUNNER_SOURCE = resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts')
const SESSION_ID = 'ses_000000001001AAAAAAAAAAAAAA'
const NONCE = 'A'.repeat(43)
const DIGEST = 'a'.repeat(64)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function seedTask(db: DbClient): Promise<void> {
  await db.insert(workflows).values({
    id: 'workflow-a',
    name: 'workflow-a',
    definition: '{}',
  })
  await db.insert(tasks).values({
    id: 'task-a',
    name: 'task-a',
    workflowId: 'workflow-a',
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: 'aw/task-a',
    status: 'running',
    inputs: '{}',
    startedAt: 1,
  })
}

async function seedRun(db: DbClient, id: string): Promise<void> {
  await db.insert(nodeRuns).values({
    id,
    taskId: 'task-a',
    nodeId: 'node-a',
    status: 'running',
  })
}

function control(
  ackPath: string,
  input: {
    mode?: 'new' | 'resume'
    expectedSessionId?: string
    createdNodeRunId?: string
  } = {},
) {
  return {
    kind: 'opencode-session' as const,
    mode: input.mode ?? ('new' as const),
    nonce: NONCE,
    leaseNonceDigest: DIGEST,
    ackPath,
    ...(input.expectedSessionId === undefined
      ? {}
      : { expectedSessionId: input.expectedSessionId }),
    identityDigest: 'identity-a',
    runtimeBinaryDigest: DIGEST,
    protocolCodec: 'opencode-direct-v1',
    sessionContractDigest: 'contract-a',
    sessionStoreKey: 'store-a',
    createdNodeRunId: input.createdNodeRunId ?? 'run-created',
  }
}

function marker(nodeRunId: string, digest = DIGEST, mode: 'new' | 'resume' = 'new'): string {
  return buildSessionReadyMarker({
    kind: mode,
    sessionId: SESSION_ID,
    projectId: 'project-a',
    reportedVersion: '1.18.3',
    binaryDigest: DIGEST,
    protocolCodec: 'opencode-direct-v1',
    nodeRunId,
    leaseNonceDigest: digest,
  })
}

function agent(): Agent {
  return {
    id: 'agent-a',
    name: 'agent-a',
    description: 'runner barrier fixture',
    outputs: ['answer'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'Answer.',
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('RFC-224 runner production boundary selection', () => {
  test('production is default while explicit test seams remain legacy', () => {
    expect(requiresVerifiedOpencodeBarrier({ runtime: 'opencode' })).toBe(true)
    expect(
      requiresVerifiedOpencodeBarrier({
        runtime: 'opencode',
        opencodeCmd: ['bun', 'mock-opencode.ts'],
      }),
    ).toBe(false)
    expect(
      requiresVerifiedOpencodeBarrier({
        runtime: 'opencode',
        testOnlyUnverifiedRuntime: true,
      }),
    ).toBe(false)
    const branded = markProductionOpencodeCommand(['/opt/opencode'])
    expect(requiresVerifiedOpencodeBarrier({ runtime: 'opencode', opencodeCmd: branded })).toBe(
      true,
    )
    expect(requiresVerifiedOpencodeBarrier({ runtime: 'claude-code' })).toBe(false)
  })
})

describe('RFC-224 runner control ownership transaction', () => {
  test('post-spawn exception reaps the launcher, awaits cleanup, and releases a preclaimed lease', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await seedRun(db, 'run-created')
    await db.insert(nodeRuns).values({
      id: 'run-finally',
      taskId: 'task-a',
      nodeId: 'node-a',
      status: 'pending',
    })
    const root = mkdtempSync(join(tmpdir(), 'rfc224-runner-finally-'))
    roots.push(root)
    const worktreePath = join(root, 'worktree')
    const appHome = join(root, 'app')
    mkdirSync(worktreePath, { recursive: true })

    const initialState = createRunnerOpencodeControlState()
    processRunnerOpencodeControlLine({
      db,
      taskId: 'task-a',
      nodeId: 'node-a',
      nodeRunId: 'run-created',
      control: control(join(root, 'initial.ack')),
      state: initialState,
      line: marker('run-created'),
    })
    expect(releaseOpencodeSessionLease(db, initialState.leaseToken!)).toBe(true)
    const owner = getOpencodeSessionOwner(db, SESSION_ID)!

    let cleanupCalled = false
    const originalBuild = opencodeDriver.buildBusinessSpawn
    const originalStartLiveCapture = opencodeDriver.startLiveCapture
    opencodeDriver.buildBusinessSpawn = async (ctx) => {
      mkdirSync(ctx.runRoot, { recursive: true })
      return {
        cmd: ['/bin/sh', '-c', 'sleep 30'],
        env: { PATH: '/usr/bin:/bin' },
        stdin: { mode: 'ignore' as const },
        sessionStore: {
          root: join(appHome, 'opencode-stores', 'business', owner.sessionStoreKey),
          dbPath: join(
            appHome,
            'opencode-stores',
            'business',
            owner.sessionStoreKey,
            'opencode.db',
          ),
          persistent: true,
        },
        control: {
          kind: 'opencode-session' as const,
          mode: 'resume' as const,
          nonce: ctx.opencodeControlNonce!,
          leaseNonceDigest: ctx.opencodeLeaseNonceDigest!,
          ackPath: join(ctx.runRoot, 'control.ack'),
          expectedSessionId: SESSION_ID,
          identityDigest: owner.identityDigest,
          runtimeBinaryDigest: owner.runtimeBinaryDigest,
          protocolCodec: owner.protocolCodec,
          sessionContractDigest: owner.sessionContractDigest,
          sessionStoreKey: owner.sessionStoreKey,
          createdNodeRunId: owner.createdNodeRunId,
        },
        cleanup: async () => {
          cleanupCalled = true
        },
      }
    }
    opencodeDriver.startLiveCapture = () => {
      throw new Error('injected-live-capture-failure')
    }

    try {
      const result = await runNode({
        taskId: 'task-a',
        nodeRunId: 'run-finally',
        nodeId: 'node-a',
        agent: agent(),
        inputs: {},
        worktreePath,
        templateMeta: {
          repoPath: worktreePath,
          baseBranch: 'main',
          taskId: 'task-a',
          nodeId: 'node-a',
        },
        skills: [],
        appHome,
        runtime: 'opencode',
        runtimeParams: {
          model: 'provider/model',
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
        },
        resumeSessionId: SESSION_ID,
        db,
      })
      expect(result).toMatchObject({
        status: 'failed',
        errorMessage: 'execution-identity-control-failed',
        failureCode: 'execution-identity-control-failed',
      })
      expect(JSON.stringify(result)).not.toContain('injected-live-capture-failure')
      expect(cleanupCalled).toBe(true)
      expect(existsSync(join(appHome, 'runs', 'task-a', 'run-finally'))).toBe(false)
      expect(getOpencodeSessionOwner(db, SESSION_ID)).toMatchObject({
        leaseNodeRunId: null,
        leaseNonceDigest: null,
      })
      const persisted = (
        await db
          .select({
            status: nodeRuns.status,
            errorMessage: nodeRuns.errorMessage,
            failureCode: nodeRuns.failureCode,
          })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, 'run-finally'))
          .limit(1)
      )[0]
      expect(persisted).toEqual({
        status: 'failed',
        errorMessage: 'execution-identity-control-failed',
        failureCode: 'execution-identity-control-failed',
      })
    } finally {
      opencodeDriver.buildBusinessSpawn = originalBuild
      opencodeDriver.startLiveCapture = originalStartLiveCapture
    }
  })

  test('missing resume owner fails before the verified builder can touch a store', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'run-missing-owner',
      taskId: 'task-a',
      nodeId: 'node-a',
      status: 'pending',
    })
    const root = mkdtempSync(join(tmpdir(), 'rfc224-runner-preclaim-'))
    roots.push(root)
    const worktreePath = join(root, 'worktree')
    mkdirSync(worktreePath, { recursive: true })
    let builderCalled = false
    const originalBuild = opencodeDriver.buildBusinessSpawn
    opencodeDriver.buildBusinessSpawn = async () => {
      builderCalled = true
      throw new Error('builder must remain unreachable')
    }

    try {
      const result = await runNode({
        taskId: 'task-a',
        nodeRunId: 'run-missing-owner',
        nodeId: 'node-a',
        agent: agent(),
        inputs: {},
        worktreePath,
        templateMeta: {
          repoPath: worktreePath,
          baseBranch: 'main',
          taskId: 'task-a',
          nodeId: 'node-a',
        },
        skills: [],
        appHome: join(root, 'app'),
        runtime: 'opencode',
        runtimeParams: {
          model: 'provider/model',
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
        },
        resumeSessionId: 'missing-session',
        db,
      })
      expect(builderCalled).toBe(false)
      expect(result).toMatchObject({
        status: 'failed',
        failureCode: 'execution-identity-session-mismatch',
        errorMessage: 'execution-identity-session-mismatch',
      })
    } finally {
      opencodeDriver.buildBusinessSpawn = originalBuild
    }
  })

  test('runNode classifies a verified launcher failure line without persisting secret diagnostics', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'run-launcher-failure',
      taskId: 'task-a',
      nodeId: 'node-a',
      status: 'pending',
    })
    const root = mkdtempSync(join(tmpdir(), 'rfc224-runner-failure-'))
    roots.push(root)
    const worktreePath = join(root, 'worktree')
    const appHome = join(root, 'app')
    mkdirSync(worktreePath, { recursive: true })
    const originalBuild = opencodeDriver.buildBusinessSpawn

    opencodeDriver.buildBusinessSpawn = async (ctx) => {
      mkdirSync(ctx.runRoot, { recursive: true })
      const ackPath = join(ctx.runRoot, 'control.ack')
      return {
        cmd: [
          '/bin/sh',
          '-c',
          'printf \'%s\\n\' "$1" >&2',
          'aw-rfc224-failure',
          'AW_OPENCODE_FAILURE execution-identity-source-changed',
        ],
        env: { PATH: '/usr/bin:/bin' },
        stdin: { mode: 'ignore' as const },
        sessionStore: {
          root: join(appHome, 'opencode-stores', 'business', 'store-failure'),
          dbPath: join(appHome, 'opencode-stores', 'business', 'store-failure', 'opencode.db'),
          persistent: true,
        },
        control: {
          kind: 'opencode-session' as const,
          mode: 'new' as const,
          nonce: ctx.opencodeControlNonce!,
          leaseNonceDigest: ctx.opencodeLeaseNonceDigest!,
          ackPath,
          identityDigest: 'identity-failure',
          runtimeBinaryDigest: DIGEST,
          protocolCodec: 'opencode-direct-v1',
          sessionContractDigest: 'contract-failure',
          sessionStoreKey: 'store-failure',
          createdNodeRunId: ctx.nodeRunId,
        },
      }
    }

    try {
      const result = await runNode({
        taskId: 'task-a',
        nodeRunId: 'run-launcher-failure',
        nodeId: 'node-a',
        agent: agent(),
        inputs: {},
        worktreePath,
        templateMeta: {
          repoPath: worktreePath,
          baseBranch: 'main',
          taskId: 'task-a',
          nodeId: 'node-a',
        },
        skills: [],
        appHome,
        runtime: 'opencode',
        runtimeParams: {
          model: 'provider/model',
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
        },
        subagentLiveCapture: { pollMs: 0, consecutiveFailureLimit: 1 },
        db,
      })
      expect(result).toMatchObject({
        status: 'failed',
        failureCode: 'execution-identity-source-changed',
        errorMessage: 'execution-identity-source-changed',
      })
      const row = await db
        .select({
          failureCode: nodeRuns.failureCode,
          errorMessage: nodeRuns.errorMessage,
        })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'run-launcher-failure'))
        .get()
      expect(row).toEqual({
        failureCode: 'execution-identity-source-changed',
        errorMessage: 'execution-identity-source-changed',
      })
      const events = await db
        .select({ payload: nodeRunEvents.payload })
        .from(nodeRunEvents)
        .where(eq(nodeRunEvents.nodeRunId, 'run-launcher-failure'))
      expect(events).toEqual([{ payload: 'execution-identity-source-changed' }])
      expect(JSON.stringify(events)).not.toContain(NONCE)
    } finally {
      opencodeDriver.buildBusinessSpawn = originalBuild
    }
  })

  test('caller node timeout after the verified marker remains attempt-scoped', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'run-caller-timeout',
      taskId: 'task-a',
      nodeId: 'node-a',
      status: 'pending',
    })
    const root = mkdtempSync(join(tmpdir(), 'rfc224-runner-caller-timeout-'))
    roots.push(root)
    const worktreePath = join(root, 'worktree')
    const appHome = join(root, 'app')
    mkdirSync(worktreePath, { recursive: true })
    const originalBuild = opencodeDriver.buildBusinessSpawn

    opencodeDriver.buildBusinessSpawn = async (ctx) => {
      mkdirSync(ctx.runRoot, { recursive: true })
      const ackPath = join(ctx.runRoot, 'control.ack')
      const ready = buildSessionReadyMarker({
        kind: 'new',
        sessionId: SESSION_ID,
        projectId: 'project-a',
        reportedVersion: '1.18.3',
        binaryDigest: DIGEST,
        protocolCodec: 'opencode-direct-v1',
        nodeRunId: ctx.nodeRunId,
        leaseNonceDigest: ctx.opencodeLeaseNonceDigest!,
      })
      return {
        cmd: [
          '/bin/sh',
          '-c',
          [
            'printf \'%s\\n\' "$1" >&2',
            'i=0',
            'while [ ! -f "$2" ] && [ "$i" -lt 500 ]; do sleep 0.001; i=$((i+1)); done',
            'grep -q "^AW_OPENCODE_ACK ok " "$2" || exit 90',
            'sleep 30',
          ].join('; '),
          'aw-rfc224-caller-timeout',
          ready,
          ackPath,
        ],
        env: { PATH: '/usr/bin:/bin' },
        stdin: { mode: 'ignore' as const },
        sessionStore: {
          root: join(appHome, 'opencode-stores', 'business', 'store-caller-timeout'),
          dbPath: join(
            appHome,
            'opencode-stores',
            'business',
            'store-caller-timeout',
            'opencode.db',
          ),
          persistent: true,
        },
        control: {
          kind: 'opencode-session' as const,
          mode: 'new' as const,
          nonce: ctx.opencodeControlNonce!,
          leaseNonceDigest: ctx.opencodeLeaseNonceDigest!,
          ackPath,
          identityDigest: 'identity-caller-timeout',
          runtimeBinaryDigest: DIGEST,
          protocolCodec: 'opencode-direct-v1',
          sessionContractDigest: 'contract-caller-timeout',
          sessionStoreKey: 'store-caller-timeout',
          createdNodeRunId: ctx.nodeRunId,
        },
      }
    }

    try {
      const result = await runNode({
        taskId: 'task-a',
        nodeRunId: 'run-caller-timeout',
        nodeId: 'node-a',
        agent: agent(),
        inputs: {},
        worktreePath,
        templateMeta: {
          repoPath: worktreePath,
          baseBranch: 'main',
          taskId: 'task-a',
          nodeId: 'node-a',
        },
        skills: [],
        appHome,
        runtime: 'opencode',
        runtimeParams: {
          model: 'provider/model',
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
        },
        timeoutMs: 50,
        killEscalationGraceMs: 20,
        subagentLiveCapture: { pollMs: 0, consecutiveFailureLimit: 1 },
        db,
      })
      expect(result).toMatchObject({
        status: 'failed',
        errorMessage: 'node-timeout: exceeded 50ms',
      })
      expect(result.failureCode).toBeUndefined()
      expect(getOpencodeSessionOwner(db, SESSION_ID)).toMatchObject({
        leaseNodeRunId: null,
        leaseNonceDigest: null,
      })
      expect(
        await db
          .select({
            errorMessage: nodeRuns.errorMessage,
            failureCode: nodeRuns.failureCode,
          })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, 'run-caller-timeout'))
          .get(),
      ).toEqual({
        errorMessage: 'node-timeout: exceeded 50ms',
        failureCode: null,
      })
    } finally {
      opencodeDriver.buildBusinessSpawn = originalBuild
    }
  })

  test('runNode consumes the marker, captures, releases, and then awaits cleanup', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'run-integrated',
      taskId: 'task-a',
      nodeId: 'node-a',
      status: 'pending',
    })
    const root = mkdtempSync(join(tmpdir(), 'rfc224-runner-integrated-'))
    roots.push(root)
    const worktreePath = join(root, 'worktree')
    const appHome = join(root, 'app')
    mkdirSync(worktreePath, { recursive: true })
    let cleanupCalled = false
    let cleanupSawReleasedLease = false
    const originalBuild = opencodeDriver.buildBusinessSpawn

    opencodeDriver.buildBusinessSpawn = async (ctx) => {
      mkdirSync(ctx.runRoot, { recursive: true })
      const ackPath = join(ctx.runRoot, 'control.ack')
      const ready = buildSessionReadyMarker({
        kind: 'new',
        sessionId: SESSION_ID,
        projectId: 'project-a',
        reportedVersion: 'future-custom-version',
        binaryDigest: DIGEST,
        protocolCodec: 'opencode-direct-v1',
        nodeRunId: ctx.nodeRunId,
        leaseNonceDigest: ctx.opencodeLeaseNonceDigest!,
      })
      const event = JSON.stringify({
        type: 'text',
        sessionID: SESSION_ID,
        timestamp: 1,
        part: {
          type: 'text',
          text: '<workflow-output><port name="answer">ok</port></workflow-output>',
        },
      })
      return {
        cmd: [
          '/bin/sh',
          '-c',
          [
            'printf \'%s\\n\' "$1" >&2',
            'i=0',
            'while [ ! -f "$2" ] && [ "$i" -lt 500 ]; do sleep 0.01; i=$((i+1)); done',
            'grep -q "^AW_OPENCODE_ACK ok " "$2" || exit 90',
            'printf \'%s\\n\' "$3"',
          ].join('; '),
          'aw-rfc224-fixture',
          ready,
          ackPath,
          event,
        ],
        env: { PATH: '/usr/bin:/bin' },
        stdin: { mode: 'ignore' as const },
        sessionStore: {
          root: join(appHome, 'opencode-stores', 'business', 'store-integrated'),
          dbPath: join(appHome, 'opencode-stores', 'business', 'store-integrated', 'opencode.db'),
          persistent: true,
        },
        control: {
          kind: 'opencode-session' as const,
          mode: 'new' as const,
          nonce: ctx.opencodeControlNonce!,
          leaseNonceDigest: ctx.opencodeLeaseNonceDigest!,
          ackPath,
          identityDigest: 'identity-integrated',
          runtimeBinaryDigest: DIGEST,
          protocolCodec: 'opencode-direct-v1',
          sessionContractDigest: 'contract-integrated',
          sessionStoreKey: 'store-integrated',
          createdNodeRunId: ctx.nodeRunId,
        },
        cleanup: async () => {
          cleanupCalled = true
          cleanupSawReleasedLease = getOpencodeSessionOwner(db, SESSION_ID)?.leaseNodeRunId === null
        },
      }
    }

    try {
      const result = await runNode({
        taskId: 'task-a',
        nodeRunId: 'run-integrated',
        nodeId: 'node-a',
        agent: agent(),
        inputs: {},
        worktreePath,
        templateMeta: {
          repoPath: worktreePath,
          baseBranch: 'main',
          taskId: 'task-a',
          nodeId: 'node-a',
        },
        skills: [],
        appHome,
        runtime: 'opencode',
        runtimeParams: {
          model: 'provider/model',
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
        },
        subagentLiveCapture: { pollMs: 0, consecutiveFailureLimit: 1 },
        db,
      })
      expect(result).toMatchObject({
        status: 'done',
        sessionId: SESSION_ID,
        outputs: { answer: 'ok' },
      })
      expect(cleanupCalled).toBe(true)
      expect(cleanupSawReleasedLease).toBe(true)
      expect(existsSync(join(appHome, 'runs', 'task-a', 'run-integrated'))).toBe(false)
      expect(getOpencodeSessionOwner(db, SESSION_ID)).toMatchObject({
        leaseNodeRunId: null,
        leaseNonceDigest: null,
      })
      expect(
        await db
          .select({ sessionId: nodeRuns.opencodeSessionId })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, 'run-integrated'))
          .get(),
      ).toEqual({ sessionId: SESSION_ID })
      const persisted = await db
        .select({ kind: nodeRunEvents.kind, payload: nodeRunEvents.payload })
        .from(nodeRunEvents)
        .where(eq(nodeRunEvents.nodeRunId, 'run-integrated'))
      expect(persisted.some((event) => event.payload.startsWith('AW_OPENCODE_CONTROL '))).toBe(
        false,
      )
    } finally {
      opencodeDriver.buildBusinessSpawn = originalBuild
    }
  })

  test('new marker claims owner+run before writing the exact ok acknowledgement', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await seedRun(db, 'run-created')
    const root = mkdtempSync(join(tmpdir(), 'rfc224-runner-new-'))
    roots.push(root)
    const ackPath = join(root, 'control.ack')
    const state = createRunnerOpencodeControlState()

    expect(
      processRunnerOpencodeControlLine({
        db,
        taskId: 'task-a',
        nodeId: 'node-a',
        nodeRunId: 'run-created',
        control: control(ackPath),
        state,
        line: 'ordinary bootstrap diagnostic',
      }),
    ).toEqual({ kind: 'stderr', line: 'ordinary bootstrap diagnostic' })
    expect(() => readControlAck(ackPath, NONCE)).toThrow('ack-read-failed')

    expect(
      processRunnerOpencodeControlLine({
        db,
        taskId: 'task-a',
        nodeId: 'node-a',
        nodeRunId: 'run-created',
        control: control(ackPath),
        state,
        line: marker('run-created'),
      }),
    ).toEqual({ kind: 'session-ready', sessionId: SESSION_ID })
    expect(readControlAck(ackPath, NONCE)).toEqual({ decision: 'ok', nonce: NONCE })
    expect(state).toMatchObject({
      ready: true,
      sessionId: SESSION_ID,
      leaseToken: {
        sessionId: SESSION_ID,
        nodeRunId: 'run-created',
        leaseNonceDigest: DIGEST,
      },
    })
    expect(getOpencodeSessionOwner(db, SESSION_ID)).toMatchObject({
      taskId: 'task-a',
      nodeId: 'node-a',
      projectId: 'project-a',
      leaseNodeRunId: 'run-created',
    })
    expect(
      await db
        .select({ sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'run-created'))
        .get(),
    ).toEqual({ sessionId: SESSION_ID })
  })

  test('resume confirms only the already-preclaimed owner/nonce and then links the run', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await seedRun(db, 'run-created')
    await seedRun(db, 'run-resume')
    const root = mkdtempSync(join(tmpdir(), 'rfc224-runner-resume-'))
    roots.push(root)

    const firstState = createRunnerOpencodeControlState()
    processRunnerOpencodeControlLine({
      db,
      taskId: 'task-a',
      nodeId: 'node-a',
      nodeRunId: 'run-created',
      control: control(join(root, 'new.ack')),
      state: firstState,
      line: marker('run-created'),
    })
    expect(releaseOpencodeSessionLease(db, firstState.leaseToken!)).toBe(true)
    const owner = getOpencodeSessionOwner(db, SESSION_ID)!
    preclaimOpencodeSessionResume(db, {
      sessionId: owner.sessionId,
      taskId: owner.taskId,
      nodeId: owner.nodeId,
      createdNodeRunId: owner.createdNodeRunId,
      identityDigest: owner.identityDigest,
      runtimeBinaryDigest: owner.runtimeBinaryDigest,
      sessionContractDigest: owner.sessionContractDigest,
      sessionStoreKey: owner.sessionStoreKey,
      projectId: owner.projectId,
      protocolCodec: owner.protocolCodec,
      reportedVersion: owner.reportedVersion,
      currentNodeRunId: 'run-resume',
      leaseNonceDigest: DIGEST,
    })
    const resumeState = createRunnerOpencodeControlState({
      sessionId: SESSION_ID,
      nodeRunId: 'run-resume',
      leaseNonceDigest: DIGEST,
    })
    const ackPath = join(root, 'resume.ack')
    expect(
      processRunnerOpencodeControlLine({
        db,
        taskId: 'task-a',
        nodeId: 'node-a',
        nodeRunId: 'run-resume',
        control: control(ackPath, {
          mode: 'resume',
          expectedSessionId: SESSION_ID,
          createdNodeRunId: 'run-created',
        }),
        resumeOwner: owner,
        state: resumeState,
        line: marker('run-resume', DIGEST, 'resume'),
      }),
    ).toEqual({ kind: 'session-ready', sessionId: SESSION_ID })
    expect(readControlAck(ackPath, NONCE).decision).toBe('ok')
    expect(
      await db
        .select({ sessionId: nodeRuns.opencodeSessionId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'run-resume'))
        .get(),
    ).toEqual({ sessionId: SESSION_ID })
  })

  test('a mismatched marker is nacked with one stable non-secret code', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedTask(db)
    await seedRun(db, 'run-created')
    const root = mkdtempSync(join(tmpdir(), 'rfc224-runner-nack-'))
    roots.push(root)
    const ackPath = join(root, 'control.ack')
    const state = createRunnerOpencodeControlState()

    let caught: unknown
    try {
      processRunnerOpencodeControlLine({
        db,
        taskId: 'task-a',
        nodeId: 'node-a',
        nodeRunId: 'run-created',
        control: control(ackPath),
        state,
        line: marker('run-created', 'b'.repeat(64)),
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ExecutionIdentityFailure)
    expect((caught as ExecutionIdentityFailure).code).toBe('execution-identity-control-failed')
    expect(String(caught)).not.toContain(NONCE)
    expect(readControlAck(ackPath, NONCE)).toEqual({ decision: 'nack', nonce: NONCE })
    expect(getOpencodeSessionOwner(db, SESSION_ID)).toBeUndefined()
  })
})

describe('RFC-224 runner reachability and safe failure stamps', () => {
  test('recognizes only the closed execution-identity error domain', () => {
    expect(
      executionIdentityFailureCodeOf(
        new ExecutionIdentityFailure('execution-identity-source-changed'),
      ),
    ).toBe('execution-identity-source-changed')
    expect(executionIdentityFailureCodeOf({ code: 'execution-identity-timeout' })).toBe(
      'execution-identity-timeout',
    )
    expect(executionIdentityFailureCodeOf(new Error(`secret=${NONCE}`))).toBeUndefined()
  })

  test('source order locks preclaim-before-build, control interception, store locator, and awaited cleanup', () => {
    const source = readFileSync(RUNNER_SOURCE, 'utf8')
    const preclaim = source.indexOf('preclaimOpencodeSessionResume(opts.db')
    const build = source.indexOf('driver.buildBusinessSpawn({')
    expect(preclaim).toBeGreaterThan(0)
    expect(build).toBeGreaterThan(preclaim)
    expect(source).toContain('processRunnerOpencodeControlLine({')
    expect(source).toContain('await persistStderrLine(parsed.line)')
    expect(source.match(/opencodeDbPath: plan\.sessionStore\.dbPath/g)?.length).toBe(2)
    expect(source).toContain('await plan.cleanup?.()')
    expect(source).toContain('opencode-session-lease-retained-for-live-process')
  })
})
