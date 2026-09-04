// RFC-356 T1 — 退避删除一棵目录树（平台无关，Windows 上才真的用得上退避）。
//
// 为什么要自己写循环，而不是 `fs.rm({ maxRetries, retryDelay })`：
// **Bun 不实现 Node 的这两个选项**（RFC-254 实证，
// `design/RFC-254-windows-native-execution/plan.md:554`）。传了也不会重试。
//
// ⚠️ 退避档**没有实测依据，是保守估计**，不要把它当成「等够了就一定删得掉」。
// RFC-254 那条常被误引的实测（「显式重试确实在跑但一秒不够」）的上下文是
// 「两步尝试**都被证伪**」，结论是「去查谁还开着，不要继续加预算」；
// `tests/fixtures/tempDir.ts:62-67` 说得更直白：「NO amount of retry helps
// (a 2s loop still failed EBUSY)」。而且那条实测是 bun:sqlite 句柄场景，与
// iso 工作树不同域。
//
// 所以本原语只是**廉价的第一道**。真正让 issue #13 自愈的是 RFC-356 的另外两层：
// L2（把 Windows 杀树接到 Job Object 上，从源头消除逃逸的句柄持有者）与
// L4（iso 键换代，绕开清不掉的残留）。
//
// 不做 `Bun.gc(true)`：那是测试夹具为 bun:sqlite 句柄准备的（同上 tempDir.ts:68），
// 被回收的工作树里没有 daemon 自己开着的 sqlite。

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { Logger } from '@/util/log'

/**
 * 默认退避档：0 / 50 / 100 / 200 / 400 / 800 / 1600 ms。
 *
 * 共 7 次尝试、总等待 ≈ 3.15s。**第一次零延迟**——POSIX 与 Windows 的常态都是
 * 一次成功，正常路径不应该为这个原语付出任何时延。
 */
export const DEFAULT_RECLAIM_DELAYS_MS: readonly number[] = [0, 50, 100, 200, 400, 800, 1600]

export interface RemoveDirectoryWithRetryResult {
  /** true = 删掉了，或本来就不存在。 */
  removed: boolean
  /** 实际尝试次数（≥1）。 */
  attempts: number
  /** 最后一次失败的错误消息；`removed` 为真时不带。 */
  lastError?: string
}

/**
 * 退避删除 `path` 及其内容。绝不抛出——回收是尽力而为，判据交给调用方。
 *
 * `delaysMs[i]` 是**第 i 次尝试之前**的等待，所以 `[0, …]` 意味着首次立即尝试。
 */
export async function removeDirectoryWithRetry(
  path: string,
  opts?: { delaysMs?: readonly number[]; log?: Logger },
): Promise<RemoveDirectoryWithRetryResult> {
  const delays = opts?.delaysMs ?? DEFAULT_RECLAIM_DELAYS_MS
  let lastError = ''
  for (let i = 0; i < delays.length; i += 1) {
    const delay = delays[i] ?? 0
    if (delay > 0) await Bun.sleep(delay)
    try {
      await rm(path, { recursive: true, force: true })
      // `force: true` 对不存在的路径静默成功，所以这里还要看一眼：Windows 上
      // `rm` 可以「成功返回」却留下被句柄占住的子项（实测过的形态）。
      if (!existsSync(path)) return { removed: true, attempts: i + 1 }
      lastError = `path still exists after rm: ${path}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  opts?.log?.warn('directory reclaim exhausted its backoff budget', {
    path,
    attempts: delays.length,
    error: lastError,
  })
  return { removed: false, attempts: delays.length, lastError }
}
