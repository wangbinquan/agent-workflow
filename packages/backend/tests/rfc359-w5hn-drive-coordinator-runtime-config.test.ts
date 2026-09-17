// RFC-359 AC-1（plan §5hn 批次二 ①②）—— 每一台 `createTaskDriveCoordinator` 都必须拿到
// **完整的运行期配置**。
//
// 为什么这条测试存在（先红后绿，红的是 20d4a6ce5 推上去的 e2e）：
// `createTaskDriveCoordinator` 内部是 `runtimeConfigOpts(input.deps)`——它从 `deps` 上读
// **十七个**运行期旋钮（`defaultNodeRetries` / `defaultPerNodeTimeoutMs` / `commitPush` /
// `mergeAgent` / `maxConcurrentNodes` / `sessionRestartBudget` / 各类并发与超时上限…）。
// 只给它 `{ db, schedulerDriver, configPath }` 时，那十七个**全是 undefined**——类型上完全
// 合法（它们都可选），运行时驱动却退回编译期缺省。
//
// 实撞：webhook 启动改走路由那台协调器之后，`webhook-mr-runtime-races` 里那个故意崩溃的
// runtime 节点被重试到 **8 次**（判据要 1 次），因为 `defaultNodeRetries` 丢了。
// **管理员调过的每一个旋钮都在那十七格里**，丢的不只是重试次数。
//
// 判据形状：`buildStartTaskDeps` 的做法是 `...resolveLaunchRuntimeConfig(configPath)`，
// 那是这个仓里「从配置漏斗取运行期旋钮」的唯一入口。于是判据就是：
// **组合根里每一处 `createTaskDriveCoordinator({ deps: { … } })` 的字面量 deps，
// 都必须 spread 一份 launch runtime config**；把 `deps` 整体交给一个已经构造好的
// `StartTaskDeps`（裸标识符）则天然合格——那条路上的旋钮已经在里面了。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', 'src')

const ROOTS = ['server.ts', 'cli/start.ts', 'cli/postgresqlDaemonApplication.ts'] as const

/** `createTaskDriveCoordinator({ … })` 的每一次调用，连同它的 `deps:` 那一段文本。 */
function coordinatorDepsBlocks(source: string): readonly string[] {
  const blocks: string[] = []
  const needle = 'createTaskDriveCoordinator({'
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
    const depsAt = source.indexOf('deps:', at)
    if (depsAt === -1) continue
    // `deps:` 到下一个顶层键（`appHome:` 是所有调用点的下一格）之间的文本。
    const end = source.indexOf('appHome', depsAt)
    blocks.push(source.slice(depsAt, end === -1 ? depsAt + 400 : end))
  }
  return blocks
}

describe('RFC-359 AC-1 —— 驱动协调器必须拿到完整的运行期配置', () => {
  test('组合根里每一处字面量 deps 都 spread 了 launch runtime config', () => {
    const offenders: string[] = []
    let inspected = 0
    for (const root of ROOTS) {
      const source = readFileSync(resolve(SRC, root), 'utf8')
      for (const block of coordinatorDepsBlocks(source)) {
        inspected += 1
        // 整体交一个已构造好的 deps（裸标识符）⇒ 旋钮已经在里面。
        if (/^deps:\s*[A-Za-z_$][\w$]*\s*,/.test(block.trim())) continue
        if (block.includes('resolveLaunchRuntimeConfig') || block.includes('launchRuntimeConfig')) {
          continue
        }
        offenders.push(`${root}: ${block.replace(/\s+/g, ' ').slice(0, 120)}`)
      }
    }
    // 语料非空：扫成 0 的话下面那条「无违规」毫无意义。
    expect(inspected, '一处 createTaskDriveCoordinator 都没扫到 ⇒ 匹配器塌了').toBeGreaterThan(2)
    expect(
      offenders,
      '这台协调器的 deps 少了运行期旋钮——`runtimeConfigOpts(deps)` 会把它们读成 undefined，' +
        '驱动退回编译期缺省（实撞：`defaultNodeRetries` 丢了，故意崩溃的节点被重试 8 次）',
    ).toEqual([])
  })

  test('变异证据：把某一处的 spread 拿掉，上面那条必须红', () => {
    const fabricated = `
      const c = createTaskDriveCoordinator({
        deps: { db, schedulerDriver, configPath },
        appHome,
      })
    `
    const blocks = coordinatorDepsBlocks(fabricated)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).not.toContain('resolveLaunchRuntimeConfig')
    expect(/^deps:\s*[A-Za-z_$][\w$]*\s*,/.test(blocks[0]!.trim())).toBe(false)
  })
})
