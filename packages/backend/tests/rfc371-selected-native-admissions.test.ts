import { expect, test } from 'bun:test'
import { nativeUsageAdmissions } from '@/platform/persistence/nativeUsageAdmissions'
import { selectedNativeUsageInvocationPersistence } from '@/platform/persistence/nativeUsageInvocationBinding'
import { nativeUsageBaselineRead } from '@/platform/persistence/nativeUsageBaselineRead'
import { createNativeUsageInvocationPersistence } from '@/modules/task-execution/composition/nativeUsageInvocation'
import { isRuntimeNativeUsageCaptureEligible } from '@/modules/runtime-management/public/queries'
import { runWithTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { describeEachProvider } from './helpers/eachProvider'
import { originalNativeLedgerFixture } from './helpers/rfc371NativeLedgerFixture'

// Locks the RFC-143 capability regression from the original 86c28 Windows CI.
test('native usage selection reads the original driver capture capability', () => {
  expect(isRuntimeNativeUsageCaptureEligible('opencode')).toBe(true)
  expect(isRuntimeNativeUsageCaptureEligible('claude-code')).toBe(false)
})

test('strict install admissions default OFF and retain all 10001 tuples without a population limit', () => {
  expect(nativeUsageAdmissions(undefined)).toEqual([])
  expect(nativeUsageAdmissions('')).toEqual([])
  expect(nativeUsageAdmissions('[]')).toEqual([])
  const tuples = Array.from({ length: 10001 }, (_, n) => ({
    registrationId: 'validation-' + n,
    configurationRevision: n + 1,
  }))
  const admitted = nativeUsageAdmissions(JSON.stringify(tuples))
  expect(admitted).toEqual(tuples)
  expect(admitted.at(-1)).toEqual(tuples[10000])
  expect(Object.isFrozen(admitted)).toBe(true)
  expect(Object.isFrozen(admitted[0])).toBe(true)
})
test('bad install tuples fail instead of broadening collection or ignoring an entry', () => {
  for (const value of [
    '{}',
    'null',
    '[null]',
    '[{"registrationId":"x","configurationRevision":0}]',
    '[{"registrationId":"x","configurationRevision":1.5}]',
    '[{"registrationId":"","configurationRevision":1}]',
    '[{"registrationId":"x","configurationRevision":1,"extra":true}]',
    '[{"registrationId":"x","configurationRevision":1},{"registrationId":"x","configurationRevision":1}]',
  ])
    expect(() => nativeUsageAdmissions(value)).toThrow()
})

describeEachProvider('actual frozen runtime selection keeps the original Task claim', (harness) => {
  test('only matching OpenCode in the original context receives the original complete-root participant', async () => {
    const f = await originalNativeLedgerFixture(harness, 'fresh', true, { rootSets: true })
    const actual = harness.applicationBinding
    const binding =
      actual.provider === 'sqlite'
        ? { ...actual, generationId: 'selected-original-test' }
        : { provider: 'postgresql' as const, runtime: actual.runtime }
    const runtime = {
      registrationId: 'validation-selection',
      configurationRevision: 7,
      protocol: 'opencode' as const,
    }
    const persistence = selectedNativeUsageInvocationPersistence(f.db, {
      binding,
      admissions: nativeUsageAdmissions(
        JSON.stringify(
          [runtime].map(({ registrationId, configurationRevision }) => ({
            registrationId,
            configurationRevision,
          })),
        ),
      ),
      ...(actual.provider === 'postgresql'
        ? { postgresqlPoolMax: actual.databaseConfig.poolMax }
        : {}),
    })!
    const input = {
      invocationId: f.binding.invocationId,
      taskId: f.binding.taskId,
      nodeRunId: f.binding.nodeRunId,
      runtime,
    }
    expect(persistence.forInvocation(input)).toBeUndefined()
    await runWithTaskExecutionContext(f.binding.executionContext, async () => {
      expect(persistence.forInvocation({ ...input, runtime: undefined })).toBeUndefined()
      expect(
        persistence.forInvocation({ ...input, runtime: { ...runtime, configurationRevision: 6 } }),
      ).toBeUndefined()
      expect(
        persistence.forInvocation({
          ...input,
          runtime: { ...runtime, registrationId: 'another-registration' },
        }),
      ).toBeUndefined()
      expect(
        persistence.forInvocation({ ...input, runtime: { ...runtime, protocol: 'claude-code' } }),
      ).toBeUndefined()
      expect(persistence.forInvocation({ ...input, taskId: 'another-task' })).toBeUndefined()
      const owner = persistence.forInvocation(input)!
      expect(owner.rootCollection).toBeDefined()
      expect(
        await owner.prepare({
          nativeSource: f.before.nativeSource,
          sourceGeneration: f.before.sourceGeneration,
          resumeRootSessionId: null,
        }),
      ).toEqual(f.before)
      expect(createTaskExecutionPersistence(f.db, { nativeUsage: persistence }).nativeUsage).toBe(
        persistence,
      )
    })
  }, 30_000)
  test('old direct factory remains usable; empty selected installation creates no participant or extra reader', async () => {
    const f = await originalNativeLedgerFixture(harness),
      actual = harness.applicationBinding
    const binding =
      actual.provider === 'sqlite'
        ? { ...actual, generationId: 'selected-original-test' }
        : { provider: 'postgresql' as const, runtime: actual.runtime }
    expect(
      selectedNativeUsageInvocationPersistence(f.db, { binding, admissions: [] }),
    ).toBeUndefined()
    expect(createTaskExecutionPersistence(f.db).nativeUsage).toBeUndefined()
    expect(
      runWithTaskExecutionContext(f.binding.executionContext, () =>
        createNativeUsageInvocationPersistence(f.db).forInvocation(f.binding),
      ),
    ).toBeDefined()
    expect(nativeUsageBaselineRead(binding, 1)).toBeUndefined()
  }, 30_000)
  test('selection is copied once and cannot mutate an already composed original participant', async () => {
    const f = await originalNativeLedgerFixture(harness)
    const admission = { registrationId: 'frozen-original', configurationRevision: 3 }
    const owner = createNativeUsageInvocationPersistence(f.db, {
      admissions: [admission],
      rootSets: true,
    })
    admission.configurationRevision = 4
    runWithTaskExecutionContext(f.binding.executionContext, () => {
      expect(
        owner.forInvocation({
          ...f.binding,
          runtime: {
            registrationId: 'frozen-original',
            configurationRevision: 3,
            protocol: 'opencode',
          },
        })?.rootCollection,
      ).toBeDefined()
      expect(
        owner.forInvocation({ ...f.binding, runtime: { ...admission, protocol: 'opencode' } }),
      ).toBeUndefined()
    })
  }, 30_000)
})
