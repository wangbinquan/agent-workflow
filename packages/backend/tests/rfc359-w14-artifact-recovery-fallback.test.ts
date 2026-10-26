import { resourcePackageArtifactCodecs } from '@/modules/resource-catalog/infrastructure/resourcePackageArtifactCodec'
import {
  reencodeBundleApplyArtifacts,
  reencodeBundleApplyReceipt,
} from '@/modules/resource-catalog/infrastructure/migration/bundleAppliesRule'
// Target recovery selects the effect adapter from explicit converted instructions.
import { describe, expect, test } from 'bun:test'
import { z, type ZodError } from 'zod'

import type {
  ResourcePackageApplyArtifactRecoveryPort,
  ResourcePackageApplyJournalSnapshot,
} from '../src/modules/resource-catalog/application/resourcePackageMaintenance'
import { createVersionedResourcePackageArtifactRecovery } from '../src/modules/resource-catalog/infrastructure/resourcePackageArtifactRecovery'

const JOURNAL: ResourcePackageApplyJournalSnapshot = Object.freeze({
  id: 'journal-1',
  state: 'committed',
  preparedArtifactsJson: resourcePackageArtifactCodecs.encode([
    {
      kind: 'skill-stage',
      skillId: 's',
      operationId: 'old',
      stagingDirectory: '/staged/s',
      targetDirectory: '/skills/s',
    },
  ]),
  receiptJson: JSON.stringify({
    journalId: 'journal-1',
    applied: [
      { operationId: 'old', resourceType: 'skill', resourceId: 's', action: 'create', name: 's' },
    ],
  }),
  updatedAt: 1,
})

const CONVERTED_JOURNAL = {
  ...JOURNAL,
  preparedArtifactsJson: reencodeBundleApplyArtifacts(
    JSON.stringify([{ kind: 'skill-stage', skillId: 's', opId: 'old', skillDir: '/skills/s' }]),
    reencodeBundleApplyReceipt(JOURNAL.receiptJson),
  ),
}

/** 解码失败长什么样：用真的 zod 报错，不是自造的 `new Error('ZodError')`。 */
function decodeFailure(): ZodError {
  const parsed = z.object({ operationId: z.string() }).safeParse({ opId: 'op-1' })
  if (parsed.success) throw new Error('fixture must fail to parse')
  return parsed.error
}

function recording(behaviour: {
  rollForward?: () => Promise<void>
  compensate?: () => Promise<void>
}): ResourcePackageApplyArtifactRecoveryPort & { readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async rollForward() {
      calls.push('rollForward')
      await behaviour.rollForward?.()
    },
    async compensate() {
      calls.push('compensate')
      await behaviour.compensate?.()
    },
  }
}

describe('RFC-395 target artifact effect routing', () => {
  test('empty target envelopes call neither effect adapter; source arrays require conversion', async () => {
    const current = recording({}),
      operations = recording({})
    const chain = createVersionedResourcePackageArtifactRecovery(current, operations)
    const empty = {
      ...JOURNAL,
      preparedArtifactsJson: resourcePackageArtifactCodecs.encode([]),
      receiptJson: JSON.stringify({ journalId: JOURNAL.id, applied: [] }),
    }
    await chain.rollForward(empty)
    await chain.compensate(empty)
    expect(current.calls).toEqual([])
    expect(operations.calls).toEqual([])
    for (const operation of ['rollForward', 'compensate'] as const)
      await expect(chain[operation]({ ...empty, preparedArtifactsJson: '[]' })).rejects.toThrow(
        'atomic-apply-artifact-envelope-invalid:resource-package',
      )
    expect(current.calls).toEqual([])
    expect(operations.calls).toEqual([])
  })
  test('① current envelope selects only the current effect adapter', async () => {
    const primary = recording({})
    const legacy = recording({})
    const chain = createVersionedResourcePackageArtifactRecovery(primary, legacy)

    await chain.rollForward(JOURNAL)
    await chain.compensate(JOURNAL)

    expect(primary.calls).toEqual(['rollForward', 'compensate'])
    expect(legacy.calls).toEqual([])
  })

  test('② converted operation instructions select only the operation adapter', async () => {
    const primary = recording({
      rollForward: () => Promise.reject(decodeFailure()),
      compensate: () => Promise.reject(decodeFailure()),
    })
    const legacy = recording({})
    const chain = createVersionedResourcePackageArtifactRecovery(primary, legacy)

    await chain.rollForward(CONVERTED_JOURNAL)
    await chain.compensate(CONVERTED_JOURNAL)

    expect(primary.calls).toEqual([])
    expect(legacy.calls).toEqual(['rollForward', 'compensate'])
  })

  test.each([new Error('effect-failed'), decodeFailure()])(
    '③ effect 错误（含 ZodError）原样抛出，不换读回侧',
    async (boom) => {
      const primary = recording({
        rollForward: () => Promise.reject(boom),
        compensate: () => Promise.reject(boom),
      })
      const legacy = recording({})
      const chain = createVersionedResourcePackageArtifactRecovery(primary, legacy)

      await expect(chain.rollForward(JOURNAL)).rejects.toThrow(boom.message)
      await expect(chain.compensate(JOURNAL)).rejects.toThrow(boom.message)

      expect(legacy.calls).toEqual([])
    },
  )

  test('④ legacy 读回侧自己失败时，报的是 legacy 那条错（不被解码错覆盖）', async () => {
    const primary = recording({ rollForward: () => Promise.reject(decodeFailure()) })
    const legacy = recording({
      rollForward: () => Promise.reject(new Error('legacy-recovery-failed')),
    })
    const chain = createVersionedResourcePackageArtifactRecovery(primary, legacy)

    await expect(chain.rollForward(CONVERTED_JOURNAL)).rejects.toThrow('legacy-recovery-failed')
  })
})
