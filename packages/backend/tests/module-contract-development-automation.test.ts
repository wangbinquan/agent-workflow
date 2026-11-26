// Module contract audit: existing Mission journeys cover launch/effect semantics.
// These cases lock the owner-facing worker's bounded continuation and failure
// contracts, and the fully composed automation's missing-Mission boundary.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  composeDevelopmentAutomation,
  createDevelopmentAutomationMaintenanceJobHandlers,
} from '@/modules/development-automation/composition'
import { createLocalVerificationCommandEffectsFactory } from '@/modules/development-automation/composition/localVerificationCommands'
import { describeEachProvider } from './helpers/eachProvider'
import {
  composeStandaloneDevelopmentAutomationSelections,
  unusedDevelopmentProviders,
} from './helpers/developmentAutomation'

describe('module contract: development-automation maintenance', () => {
  test('a full upload slice yields one continuation, while partial and empty slices terminate', async () => {
    const calls: number[] = []
    const results = [1000, 17, 0]
    const handlers = createDevelopmentAutomationMaintenanceJobHandlers({
      async sweepExpiredUploads(_now, limit) {
        calls.push(limit)
        return results.shift()!
      },
      async sweepRetention() {
        throw new Error('upload cleanup must not run retention')
      },
    })
    const first = await handlers.developmentUploadGc({ appHome: '/unused', payload: {} })
    expect(first).toEqual({
      counters: { swept: 1000 },
      delta: { kind: 'none' },
      continuation: { cursor: { version: 1 }, resumeAfterMs: 25 },
    })
    const second = await handlers.developmentUploadGc({
      appHome: '/unused',
      payload: {},
      cursor: first.continuation!.cursor,
    })
    expect(second).toEqual({ counters: { swept: 17 }, delta: { kind: 'none' } })
    expect(await handlers.developmentUploadGc({ appHome: '/unused', payload: {} })).toEqual({
      counters: { swept: 0 },
      delta: { kind: 'none' },
    })
    expect(calls).toEqual([1000, 1000, 1000])
  })

  test('retention reports all four business counters from one command without running upload cleanup', async () => {
    const expected = {
      missionsScanned: 21,
      prunedAttempts: 34,
      markedBundleRefs: 8,
      expiredBundleRefsPending: 3,
    }
    let calls = 0
    const handlers = createDevelopmentAutomationMaintenanceJobHandlers({
      async sweepExpiredUploads() {
        throw new Error('retention must not run upload cleanup')
      },
      async sweepRetention(now) {
        expect(Number.isSafeInteger(now)).toBe(true)
        calls += 1
        return expected
      },
    })
    expect(await handlers.developmentRetentionSweep({ appHome: '/unused', payload: {} })).toEqual({
      counters: expected,
      delta: { kind: 'none' },
    })
    expect(calls).toBe(1)
  })

  test('malformed continuation does no work and failure can be retried without a false success receipt', async () => {
    let calls = 0
    const failure = new Error('development-upload-store-unavailable')
    const handlers = createDevelopmentAutomationMaintenanceJobHandlers({
      async sweepExpiredUploads() {
        calls += 1
        if (calls === 1) throw failure
        return 5
      },
      async sweepRetention() {
        throw new Error('not used')
      },
    })
    await expect(
      handlers.developmentUploadGc({ appHome: '/unused', payload: {}, cursor: { version: 2 } }),
    ).rejects.toThrow('maintenance-development-upload-cursor-invalid')
    expect(calls).toBe(0)
    const input = { appHome: '/unused', payload: {}, cursor: { version: 1 } }
    await expect(handlers.developmentUploadGc(input)).rejects.toBe(failure)
    expect(await handlers.developmentUploadGc(input)).toEqual({
      counters: { swept: 5 },
      delta: { kind: 'none' },
    })
    expect(calls).toBe(2)
  })
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describeEachProvider('module contract: composed development-automation', (harness) => {
  test('a missing Mission stops after one reconcile and never invokes an external provider', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-module-development-'))
    roots.push(appHome)
    const module = composeDevelopmentAutomation({
      ...composeStandaloneDevelopmentAutomationSelections({ db: harness.db, appHome }),
      ...unusedDevelopmentProviders(),
      verificationCommands: createLocalVerificationCommandEffectsFactory(),
      db: harness.db,
      appHome,
    })
    expect(await module.drive('module-contract-missing-mission')).toEqual({
      steps: 1,
      stop: 'not-found',
      last: { kind: 'not-found' },
    })
    expect(await module.reconcile('module-contract-missing-mission')).toEqual({ kind: 'not-found' })
    expect(await module.sweepWakes()).toEqual({ reconciled: 0 })
  })
})
