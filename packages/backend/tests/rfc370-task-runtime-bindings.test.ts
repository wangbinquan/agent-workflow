import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { DEFAULT_CONFIG_DIR_PROFILE } from '@agent-workflow/shared'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { createLocalTaskAgentRuntimeBindings } from '../src/modules/runtime-management/infrastructure/local/taskAgentRuntimeBindings'
import type { RuntimeExecutionQueries } from '../src/modules/runtime-management/public/queries'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { composeNodeRunRuntimePersistence } from './helpers/nodeRunRuntime'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'
import { runtimeRegistryPersistence } from './helpers/runtimeRegistryPersistence'
import {
  createRuntime,
  seedBuiltinRuntimes,
  updateRuntime,
} from './helpers/runtimeRegistryApplication'
import { canonicalBinaryPath } from './fixtures/platformPaths'

async function seed(harness: ProviderHarness) {
  const db = harness.db,
    workflowId = ulid(),
    taskId = ulid(),
    id = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'selected-runtime',
    definition: '{}',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(tasks).values({
    id: taskId,
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
    name: 'selected-runtime',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/r',
    worktreePath: '/w',
    baseBranch: 'main',
    branch: 'task',
    status: 'running',
    inputs: '{}',
    startedAt: 1,
  })
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'n1', status: 'pending' })
  return { db, id }
}
async function columns(harness: ProviderHarness, id: string) {
  return (
    await harness.db
      .select({ protocol: nodeRuns.runtime, binary: nodeRuns.runtimeBinary })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, id))
  )[0]
}

describeEachProvider('RFC-370 selected Task runtime bindings', (harness) => {
  test('normal snapshots keep a changed custom binary frozen through resume and fresh-row session inheritance', async () => {
    const first = await seed(harness),
      registry = runtimeRegistryPersistence(harness.db)
    await seedBuiltinRuntimes(registry)
    const name = 'family-' + ulid().slice(-20).toLowerCase(),
      originalBinary = canonicalBinaryPath('family-v1')
    await createRuntime(registry, { name, protocol: 'claude-code', binaryPath: originalBinary })
    let configReads = 0
    const selected = createLocalTaskAgentRuntimeBindings({
      persistence: composeNodeRunRuntimePersistence(harness.db),
      registry: composeRuntimeRegistryOperations(harness.db),
      readBinaryConfiguration: async () => {
        configReads++
        return {}
      },
    })
    const frozen = await selected.bindings.resolve(first.id, name, null)
    expect(frozen.protocol).toBe('claude-code')
    if (frozen.runtimeBinding === null) throw new Error('custom binding missing')
    expect(selected.contents.runtimeBinary(frozen.runtimeBinding)).toBe(originalBinary)
    expect('binary' in frozen).toBe(false)
    await updateRuntime(registry, name, { binaryPath: canonicalBinaryPath('family-v2') })
    const resumed = await selected.bindings.resolve(first.id, name, 'opencode')
    if (resumed.runtimeBinding === null) throw new Error('resumed binding missing')
    expect(selected.contents.runtimeBinary(resumed.runtimeBinding)).toBe(originalBinary)
    const session = 'session-' + ulid()
    await harness.db
      .update(nodeRuns)
      .set({ opencodeSessionId: session })
      .where(eq(nodeRuns.id, first.id))
    const inherited = await selected.bindings.ofSession(session)
    if (inherited === null || inherited.runtimeBinding === null)
      throw new Error('session binding missing')
    expect(selected.contents.runtimeBinary(inherited.runtimeBinding)).toBe(originalBinary)
    const retry = await seed(harness)
    const child = await selected.bindings.resolve(retry.id, 'opencode', 'opencode', inherited)
    if (child.runtimeBinding === null) throw new Error('inherited binding missing')
    expect(child.protocol).toBe('claude-code')
    expect(selected.contents.runtimeBinary(child.runtimeBinding)).toBe(originalBinary)
    expect(await columns(harness, retry.id)).toEqual({
      protocol: 'claude-code',
      binary: originalBinary,
    })
    expect(configReads).toBe(3)
  })

  test('configuration rejection is awaited before the original freeze transaction and preserves its error', async () => {
    const row = await seed(harness)
    let reject!: (reason: unknown) => void
    const configuration = new Promise<undefined>((_resolve, fail) => {
      reject = fail
    })
    const selected = createLocalTaskAgentRuntimeBindings({
      persistence: composeNodeRunRuntimePersistence(harness.db),
      registry: composeRuntimeRegistryOperations(harness.db),
      readBinaryConfiguration: () => configuration,
    })
    let settled = false
    const pending = selected.bindings.resolve(row.id, 'claude-code', null).finally(() => {
      settled = true
    })
    expect(await columns(harness, row.id)).toEqual({ protocol: null, binary: null })
    expect(settled).toBe(false)
    const original = new Error('selected binary configuration unavailable')
    const result = pending.then(
      () => {
        throw new Error('configuration rejection unexpectedly resolved')
      },
      (reason: unknown) => reason,
    )
    reject(original)
    expect(await result).toBe(original)
    expect(settled).toBe(true)
    expect(await columns(harness, row.id)).toEqual({ protocol: null, binary: null })
  })

  test('internal profile lookup stays early while its getters remain at child snapshot construction before configuration', async () => {
    const row = await seed(harness),
      calls: string[] = []
    const read = <T>(name: string, value: T): T => {
      calls.push(name)
      return value
    }
    const resolved = {
      get protocol() {
        return read('protocol', 'opencode' as const)
      },
      get binaryPath() {
        return read('binaryPath', canonicalBinaryPath('family-internal'))
      },
      get model() {
        return read('model', 'internal-model')
      },
      get variant() {
        return read('variant', null)
      },
      get temperature() {
        return read('temperature', null)
      },
      get steps() {
        return read('steps', null)
      },
      get maxSteps() {
        return read('maxSteps', null)
      },
      get isSandbox() {
        return read('isSandbox', false)
      },
      get configDir() {
        return read('configDir', DEFAULT_CONFIG_DIR_PROFILE.opencode)
      },
      get observationIdentity() {
        return read('observationIdentity', undefined)
      },
    }
    const queries = {
      async resolveInternalAgentRuntime() {
        expect(this).toBe(queries)
        calls.push('registry')
        return resolved
      },
    } as unknown as RuntimeExecutionQueries
    const selected = createLocalTaskAgentRuntimeBindings({
      persistence: composeNodeRunRuntimePersistence(harness.db),
      registry: queries,
      readBinaryConfiguration: async () => {
        calls.push('configuration')
        return {}
      },
    })
    const inherited = await selected.bindings.internal({ runtimeName: 'selected-internal' })
    expect(calls).toEqual(['registry'])
    const frozen = await selected.bindings.resolve(row.id, null, null, inherited)
    expect(calls).toEqual([
      'registry',
      'protocol',
      'binaryPath',
      'model',
      'variant',
      'temperature',
      'steps',
      'maxSteps',
      'isSandbox',
      'configDir',
      'observationIdentity',
      'configuration',
    ])
    expect(frozen.params.model).toBe('internal-model')
    if (frozen.runtimeBinding === null) throw new Error('internal binding missing')
    expect(selected.contents.runtimeBinary(frozen.runtimeBinding)).toBe(
      canonicalBinaryPath('family-internal'),
    )
  })
})
