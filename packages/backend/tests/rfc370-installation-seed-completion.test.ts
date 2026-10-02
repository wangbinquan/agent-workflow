import { expect, test } from 'bun:test'
import { agents, capabilityTemplates, workflows } from '@/db/schema'
import { composeCodeCapabilityDemoSeedParticipant } from '@/modules/code-capability/composition/demoSeed'
import { composeDemoResourceCatalogSeedParticipant } from '@/modules/resource-catalog/composition/demoResourceCatalogSeed'
import { composeInstallationSeedCompletion } from '@/modules/system-operations/composition/installationSeedCompletion'
import type { InstallationSeedCompletionPort } from '@/modules/system-operations/public/participants'
import { DEMO_AGENT_ID, seedDemoContent } from '@/services/demoSeed'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-370 selected installation seed completion', (harness) => {
  const participants = () => ({
    resourceCatalog: composeDemoResourceCatalogSeedParticipant(harness.db),
    codeCapability: composeCodeCapabilityDemoSeedParticipant(harness.db),
  })
  const snapshot = async () => ({
    agents: await harness.db.select().from(agents).all(),
    workflows: await harness.db.select().from(workflows).all(),
    templates: await harness.db.select().from(capabilityTemplates).all(),
  })

  for (const offered of [true, false]) {
    test(`awaits selected ${offered ? 'completed' : 'fresh'} fact before calling any owner`, async () => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const recorded: number[] = []
      const completion: InstallationSeedCompletionPort = {
        async hasCompleted() {
          expect(this).toBe(completion)
          entered.resolve()
          await release.promise
          return offered
        },
        async recordCompleted(at) {
          expect(this).toBe(completion)
          recorded.push(at)
        },
      }
      expect(composeInstallationSeedCompletion(completion)).toBe(completion)
      const before = await snapshot()
      let settled = false
      const result = seedDemoContent({ ...participants(), completion }).then((value) => {
        settled = true
        return value
      })
      try {
        await entered.promise
        expect(settled).toBe(false)
        expect(await snapshot()).toEqual(before)
        expect(recorded).toEqual([])
      } finally {
        release.resolve()
      }
      expect(await result).toEqual(
        offered ? { seeded: false, reason: 'already-offered' } : { seeded: true },
      )
      if (offered) {
        expect(await snapshot()).toEqual(before)
        expect(recorded).toEqual([])
      } else {
        expect((await snapshot()).agents.map((row) => row.id)).toContain(DEMO_AGENT_ID)
        expect(recorded).toHaveLength(1)
        expect(recorded[0]).toBeGreaterThan(0)
      }
    })
  }

  test('records completion only after both real owners and awaits durable acknowledgement', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let completed = false
    const completion: InstallationSeedCompletionPort = {
      hasCompleted: () => completed,
      async recordCompleted() {
        expect((await snapshot()).agents.map((row) => row.id)).toContain(DEMO_AGENT_ID)
        expect((await snapshot()).templates).toHaveLength(1)
        entered.resolve()
        await release.promise
        completed = true
      },
    }
    let settled = false
    const result = seedDemoContent({ ...participants(), completion }).then((value) => {
      settled = true
      return value
    })
    try {
      await entered.promise
      expect(settled).toBe(false)
      expect(completed).toBe(false)
    } finally {
      release.resolve()
    }
    expect(await result).toEqual({ seeded: true })
    const before = await snapshot()
    expect(await seedDemoContent({ ...participants(), completion })).toEqual({
      seeded: false,
      reason: 'already-offered',
    })
    expect(await snapshot()).toEqual(before)
  })

  test('partial owner failure leaves completion absent and retries the original owner sequence', async () => {
    const actual = participants()
    let completeCount = 0
    const completion: InstallationSeedCompletionPort = {
      hasCompleted: () => completeCount > 0,
      recordCompleted: async () => {
        completeCount += 1
      },
    }
    expect(
      await seedDemoContent({
        ...actual,
        completion,
        codeCapability: {
          ensure: async () => {
            throw new Error('second owner unavailable')
          },
        },
      }),
    ).toEqual({ seeded: false, reason: 'error' })
    expect(completeCount).toBe(0)
    expect((await snapshot()).agents.map((row) => row.id)).toContain(DEMO_AGENT_ID)
    expect((await snapshot()).templates).toEqual([])
    expect(await seedDemoContent({ ...actual, completion })).toEqual({ seeded: true })
    expect(completeCount).toBe(1)
    expect((await snapshot()).agents).toHaveLength(1)
    expect((await snapshot()).workflows).toHaveLength(2)
    expect((await snapshot()).templates).toHaveLength(1)
  })

  test('selected read failure propagates before owner writes', async () => {
    const before = await snapshot()
    const failure = new Error('installation completion unavailable')
    await expect(
      seedDemoContent({
        ...participants(),
        completion: {
          hasCompleted: async () => {
            throw failure
          },
          recordCompleted: () => {
            throw new Error('must not mark completion')
          },
        },
      }),
    ).rejects.toBe(failure)
    expect(await snapshot()).toEqual(before)
  })

  test('selected completion failure propagates and permits an idempotent owner retry', async () => {
    const failure = new Error('completion acknowledgement unavailable')
    await expect(
      seedDemoContent({
        ...participants(),
        completion: {
          hasCompleted: async () => false,
          recordCompleted: async () => {
            throw failure
          },
        },
      }),
    ).rejects.toBe(failure)
    const before = await snapshot()
    let recorded = 0
    expect(
      await seedDemoContent({
        ...participants(),
        completion: {
          hasCompleted: async () => false,
          recordCompleted: async () => {
            recorded += 1
          },
        },
      }),
    ).toEqual({ seeded: true })
    expect(recorded).toBe(1)
    expect(await snapshot()).toEqual(before)
  })
})
