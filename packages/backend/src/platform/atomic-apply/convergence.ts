import { ulid } from 'ulid'
import type {
  AtomicApplyRecovery,
  AtomicApplyRecoveryScene,
  AtomicApplyRow,
} from '@/platform/contracts/atomicApply'
import { ATOMIC_APPLY_LEASE_MS } from './lease'

/**
 * 按 journal 状态给出候选动作。RFC-401 T4：是否真的动手由 claim 决定——恢复先以新令牌接管（只有租约已过期或没有 claim 行
 * 的记录能被接管），接管成功才执行补偿 / 前滚；本进程活跃的记录只是跳过的优化。此前的判据是「不在本进程活跃快照且
 * updatedAt 超过十分钟」。
 */
export function decideAtomicApplyConverge(
  row: Pick<AtomicApplyRow, 'id' | 'state'>,
  input: { readonly activeJournalIds: ReadonlySet<string> },
): { readonly kind: 'skip' | 'compensate' | 'roll-forward' } {
  if (input.activeJournalIds.has(row.id)) return { kind: 'skip' }
  if (row.state === 'committed') return { kind: 'roll-forward' }
  if (row.state === 'prepared' || row.state === 'applying') return { kind: 'compensate' }
  return { kind: 'skip' }
}

/** 每个场景只注册 journal 与恢复钩子；调度和状态写回只有这一份。 */
export function createAtomicApplyRecovery<const Scenes extends readonly AtomicApplyRecoveryScene[]>(
  scenes: Scenes,
  now: () => number = Date.now,
  token: () => string = ulid,
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
          const activeJournalIds = new Set(active[scene.key])
          for (const row of await scene.list()) {
            const action = decideAtomicApplyConverge(row, { activeJournalIds }).kind
            if (action === 'skip') continue
            const claimToken = token()
            const claimed = await scene.claim(row, {
              token: claimToken,
              expiresAt: sceneNow() + ATOMIC_APPLY_LEASE_MS,
              now: sceneNow(),
            })
            // 他人持有未过期的 claim（在途 apply 或另一进程的恢复），或尾部已完成：不动。
            if (claimed !== 'taken') continue
            // 恢复失败的备注沿用此前的写法：前滚的备注刷新 updatedAt，补偿的备注不刷新。
            const noteTime = action === 'roll-forward' ? { updatedAt: sceneNow() } : {}
            const fence = (release: boolean, tail?: 'pending' | 'complete') => ({
              token: claimToken,
              now: sceneNow(),
              release,
              ...(tail === undefined ? {} : { tail }),
            })
            try {
              const complete = await scene.recover(row, action)
              if (complete === false) {
                // 未完成：写下备注并释放租约，下一轮再接管。
                await scene.compareAndSet(
                  row,
                  {
                    error:
                      action === 'roll-forward'
                        ? scene.errors.committedIncomplete
                        : 'retryable: compensation incomplete',
                    ...noteTime,
                  },
                  fence(true),
                )
                continue
              }
              if (action === 'compensate') {
                if (
                  await scene.compareAndSet(
                    row,
                    { state: 'failed', error: scene.errors.abandoned, updatedAt: sceneNow() },
                    fence(true),
                  )
                )
                  failed += 1
              } else {
                // 前滚的效果已完成；尾部完成标记写不进去只让下一轮再前滚一次（前滚幂等）。
                rolledForward += 1
                await scene.compareAndSet(
                  row,
                  row.error === null ? {} : { error: null, updatedAt: sceneNow() },
                  fence(true, 'complete'),
                )
              }
            } catch (error) {
              scene.warn(error, row, action)
              await scene.compareAndSet(
                row,
                { error: scene.errors.retryable(error, action), ...noteTime },
                fence(true),
              )
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
