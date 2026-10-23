import type {
  AtomicApplyRecovery,
  AtomicApplyRecoveryScene,
  AtomicApplyRow,
} from '@/platform/contracts/atomicApply'

export const ATOMIC_APPLY_RECOVERY_MIN_AGE_MS = 10 * 60 * 1000

/** II-a 保留现有活跃快照与十分钟窗口；新增持久 lease 留到 schema 切换。 */
export function decideAtomicApplyConverge(
  row: Pick<AtomicApplyRow, 'id' | 'state' | 'updatedAt'>,
  input: { readonly reapBefore: number; readonly activeJournalIds: ReadonlySet<string> },
): { readonly kind: 'skip' | 'compensate' | 'roll-forward' } {
  if (row.state === 'committed') return { kind: 'roll-forward' }
  if (row.state === 'prepared' || row.state === 'applying') {
    return {
      kind:
        input.activeJournalIds.has(row.id) || row.updatedAt > input.reapBefore
          ? 'skip'
          : 'compensate',
    }
  }
  return { kind: 'skip' }
}

/** 每个场景只注册 journal 与恢复钩子；调度和状态写回只有这一份。 */
export function createAtomicApplyRecovery<const Scenes extends readonly AtomicApplyRecoveryScene[]>(
  scenes: Scenes,
  now: () => number = Date.now,
): AtomicApplyRecovery<Scenes[number]['key']> {
  const registered = new Map(scenes.map((scene) => [scene.key, scene]))
  if (registered.size !== scenes.length) throw new Error('atomic-apply-duplicate-scene')
  return Object.freeze({
    async converge(activeByScene: Readonly<Record<Scenes[number]['key'], readonly string[]>>) {
      // 缺 key 不能解释为没有活跃 apply；先校验整张快照，任何场景都尚未执行。
      const active: Readonly<Record<string, readonly string[]>> = activeByScene
      for (const key of registered.keys()) {
        if (!Object.hasOwn(active, key) || !Array.isArray(active[key]))
          throw new Error(`atomic-apply-active-scene-missing:${key}`)
      }
      for (const key of Object.keys(active)) {
        if (!registered.has(key)) throw new Error(`atomic-apply-active-scene-unknown:${key}`)
      }
      let failed = 0
      let rolledForward = 0
      for (const scene of registered.values()) {
        try {
          const sceneNow = scene.now ?? now
          const reapBefore = sceneNow() - ATOMIC_APPLY_RECOVERY_MIN_AGE_MS
          const activeJournalIds = new Set(active[scene.key])
          for (const row of await scene.list()) {
            const action = decideAtomicApplyConverge(row, { reapBefore, activeJournalIds }).kind
            if (action === 'skip') continue
            // 恢复失败的备注不是在途活动，不能刷新 prepared / applying 的十分钟窗口。
            const noteTime = action === 'roll-forward' ? { updatedAt: sceneNow() } : {}
            try {
              const complete = await scene.recover(row, action)
              if (complete === false) {
                await scene.compareAndSet(row, {
                  error:
                    action === 'roll-forward'
                      ? scene.errors.committedIncomplete
                      : 'retryable: compensation incomplete',
                  ...noteTime,
                })
                continue
              }
              if (action === 'compensate') {
                if (
                  await scene.compareAndSet(row, {
                    state: 'failed',
                    error: scene.errors.abandoned,
                    updatedAt: sceneNow(),
                  })
                )
                  failed += 1
              } else {
                if (row.error !== null)
                  await scene.compareAndSet(row, { error: null, updatedAt: sceneNow() })
                rolledForward += 1
              }
            } catch (error) {
              scene.warn(error, row, action)
              await scene.compareAndSet(row, {
                error: scene.errors.retryable(error, action),
                ...noteTime,
              })
            }
          }
        } catch (error) {
          // list / 错误备注写入失败只结束当前场景；保留已完成计数并继续下一场景。
          scene.warnScene(error)
        }
      }
      return Object.freeze({ failed, rolledForward })
    },
  })
}
