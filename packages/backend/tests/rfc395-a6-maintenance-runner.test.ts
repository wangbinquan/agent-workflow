// RFC-395 II-a A6 — 逐场景失败隔离与活动快照；真实 runner 接线见 rfc271-impl-gate-fixes。
import { expect, test } from 'bun:test'
import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import type { AtomicApplyRecoveryScene, AtomicApplyRow } from '@/platform/contracts/atomicApply'

function scene<Key extends string>(
  key: Key,
  rows: AtomicApplyRow[],
  calls: string[],
  warnings: unknown[],
): AtomicApplyRecoveryScene<Key> {
  return {
    key,
    now: () => 1_000_000,
    list: async () => rows,
    compareAndSet: async (row, patch) => {
      Object.assign(row, patch)
      return true
    },
    recover: async (row) => {
      calls.push(`${key}:${row.id}`)
    },
    errors: {
      abandoned: 'abandoned',
      committedIncomplete: 'incomplete',
      retryable: () => 'retryable',
    },
    warn: (error) => {
      warnings.push(error)
    },
    warnScene: (error) => {
      warnings.push(error)
    },
  }
}
function row(id: string, state: AtomicApplyRow['state'] = 'prepared'): AtomicApplyRow {
  return { id, state, preparedArtifactsJson: '[]', receiptJson: null, error: null, updatedAt: 1 }
}

test.each(['clock', 'list', 'note'] as const)(
  'a scene %s failure preserves completed counts and runs the other scene',
  async (failure) => {
    const calls: string[] = [],
      warnings: unknown[] = []
    const original = new Error('scene unavailable')
    const intent = scene('intent', [row('completed', 'committed'), row('bad')], calls, warnings)
    const failing: typeof intent =
      failure === 'clock'
        ? {
            ...intent,
            now: () => {
              throw original
            },
          }
        : failure === 'list'
          ? {
              ...intent,
              list: async () => {
                throw original
              },
            }
          : {
              ...intent,
              recover: async (entry, action) => {
                if (entry.id === 'bad') throw new Error('effect failed')
                return intent.recover(entry, action)
              },
              compareAndSet: async () => {
                throw original
              },
            }
    const packageRow = row('p')
    const recovery = createAtomicApplyRecovery([
      failing,
      scene('resource-package', [packageRow], calls, warnings),
    ])
    expect(await recovery.converge({ intent: [], 'resource-package': [] })).toEqual({
      failed: 1,
      rolledForward: failure === 'note' ? 1 : 0,
    })
    expect(packageRow.state).toBe('failed')
    expect(warnings).toContain(original)
  },
)

test('missing or unknown registered activity keys fail before any recovery effect', async () => {
  const calls: string[] = [],
    warnings: unknown[] = []
  const recovery = createAtomicApplyRecovery([
    scene('intent', [row('i')], calls, warnings),
    scene('resource-package', [row('p')], calls, warnings),
  ])
  for (const active of [{ intent: [] }, { intent: [], 'resource-package': [], typo: [] }]) {
    await expect(
      recovery.converge(active as Parameters<typeof recovery.converge>[0]),
    ).rejects.toThrow('atomic-apply-active-scene-')
  }
  expect(calls).toEqual([])
  // @ts-expect-error scene keys are part of the registered contract
  const missing: Parameters<typeof recovery.converge>[0] = { intent: [] }
  // @ts-expect-error an unknown scene cannot silently replace resource-package
  const misspelled: Parameters<typeof recovery.converge>[0] = { intent: [], typo: [] }
  expect(Object.keys(missing)).toEqual(['intent'])
  expect(Object.keys(misspelled)).toEqual(['intent', 'typo'])
})
