// Epoch-2 keeps provider-neutral seeding; config upgrades are B conversion rules.
import { expect, test } from 'bun:test'
import { initializeRuntimeRegistryBoot } from '@/modules/runtime-management/composition/runtimeRegistry'
test('seeding runs once and finishes before ordinary boot continues', async () => {
  const events: string[] = []
  await initializeRuntimeRegistryBoot({
    operations: {
      async seedBuiltinRuntimes() {
        events.push('seed')
      },
    },
    onRecoverableFailure(error) {
      throw error
    },
  })
  events.push('continue')
  expect(events).toEqual(['seed', 'continue'])
})
test('the original recoverable seed failure is reported once', async () => {
  const failure = new Error('seed-failed'),
    errors: unknown[] = []
  await initializeRuntimeRegistryBoot({
    operations: {
      async seedBuiltinRuntimes() {
        throw failure
      },
    },
    onRecoverableFailure: (error) => {
      errors.push(error)
    },
  })
  expect(errors).toEqual([failure])
})
