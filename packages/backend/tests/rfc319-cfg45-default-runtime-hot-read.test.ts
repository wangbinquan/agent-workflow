// RFC-319 CFG-45 —— 设置页把默认运行时改到另一行之后，**新任务**必须按新那一行派发。
//
// 由来：`POST /api/tasks` 的启动走一台在 daemon boot 时建好、之后一直服务每一次请求的长驻
// 协调器（`cli/start.ts` 的 `routeLaunchDriveCoordinator` / PG daemon 的
// `boundTaskDriveCoordinator`）。RFC-359 AC-1 把路由启动改走这台协调器之后，`createTaskDriveCoordinator`
// 在**构造时**就把 17 个运行期旋钮解析成不可变快照——于是用户在设置页点了「设为默认」、
// `config.defaultRuntime` 也确实落库了，新任务却照旧冻结着老运行时的档案：
// 「设为默认」只改了界面，任务照老模型 / 参数烧钱。e2e CFG-45 断言的正是这条
// （`e2e/rfc319-intent-task-and-settings.spec.ts`：改默认之后新任务的 `runtime_params_json.model`
// 必须是新那一行的模型）。
//
// 处置：长驻协调器传 `refreshLaunchConfig`，运行期配置在**每次 drive** 现读一次
// （`runtime` 以 getter 交给 `DefaultTaskDriveCoordinator`，它在 `contextFor` 里每次读一次）。
// 「只有一处解析、start / resume / retry 不会各自漂移」这一点不变——变的只是那一处在哪个时刻。
//
// 本判据直接读协调器交给每次 drive 的那份配置（而不是去站起一整条启动链）：改配置文件、
// 再读一次，值必须跟着变；不传 refresher 的短命形态保持冻结语义（那种形态的「构造时」
// 就是「请求时」）。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { DbClient } from '@/db/client'
import type { ResolvedTaskDriveConfig } from '@/modules/task-execution/composition/taskDriveLegacy'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { createTaskDriveCoordinator } from '@/services/task'

const ROOT = resolve(import.meta.dir, '..', '..', '..')

/** 协调器交给每一次 drive 的那份配置（`DefaultTaskDriveCoordinator.contextFor` 读的就是它）。 */
function runtimeOf(coordinator: unknown): ResolvedTaskDriveConfig {
  return (coordinator as { options: { runtime: ResolvedTaskDriveConfig } }).options.runtime
}

function writeConfig(configPath: string, defaultRuntime: string): void {
  writeFileSync(configPath, `${JSON.stringify({ defaultRuntime }, null, 2)}\n`, 'utf-8')
}

function coordinatorFor(input: {
  readonly appHome: string
  readonly configPath: string
  readonly refresh: boolean
}) {
  return createTaskDriveCoordinator({
    deps: {
      db: {} as unknown as DbClient,
      schedulerDriver: {
        async drive() {
          // 本判据不驱动引擎，只看协调器交出来的配置。
        },
      },
      configPath: input.configPath,
      ...resolveLaunchRuntimeConfig(input.configPath),
    } as unknown as Parameters<typeof createTaskDriveCoordinator>[0]['deps'],
    appHome: input.appHome,
    engineFailureMessage: 'test drive failed',
    failureReporter: { report() {} },
    ...(input.refresh
      ? { refreshLaunchConfig: () => resolveLaunchRuntimeConfig(input.configPath) }
      : {}),
  })
}

describe('RFC-319 CFG-45 —— 默认运行时的热读', () => {
  test('长驻协调器：改完 config.defaultRuntime，下一次 drive 拿到的就是新值', () => {
    const home = mkdtempSync(join(tmpdir(), 'aw-cfg45-hot-'))
    try {
      const configPath = join(home, 'config.json')
      writeConfig(configPath, 'runtime-before')
      const coordinator = coordinatorFor({ appHome: home, configPath, refresh: true })
      expect(runtimeOf(coordinator).runtime.defaultRuntime).toBe('runtime-before')
      // 用户在设置页点「设为默认」——落库的就是这个文件。
      writeConfig(configPath, 'runtime-after')
      expect(
        runtimeOf(coordinator).runtime.defaultRuntime,
        '改完默认运行时之后新任务仍然按老那一行派发 ⇒ 「设为默认」只改了界面',
      ).toBe('runtime-after')
      // appHome / ensureWorkspaceProfiles 这类构造期事实不受影响。
      expect(runtimeOf(coordinator).appHome).toBe(home)
      expect(runtimeOf(coordinator).ensureWorkspaceProfiles).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('短命形态（不传 refresher）保持冻结语义：构造时那一份贯穿始终', () => {
    const home = mkdtempSync(join(tmpdir(), 'aw-cfg45-frozen-'))
    try {
      const configPath = join(home, 'config.json')
      writeConfig(configPath, 'runtime-before')
      const coordinator = coordinatorFor({ appHome: home, configPath, refresh: false })
      writeConfig(configPath, 'runtime-after')
      expect(runtimeOf(coordinator).runtime.defaultRuntime).toBe('runtime-before')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('两个 daemon 组合根都把长驻协调器接上了热读（少一个就是那个引擎独有的哑火）', () => {
    const sqlite = readFileSync(resolve(ROOT, 'packages/backend/src/cli/start.ts'), 'utf-8')
    const postgresql = readFileSync(
      resolve(ROOT, 'packages/backend/src/cli/postgresqlDaemonApplication.ts'),
      'utf-8',
    )
    // SQLite：路由启动那台长驻协调器经工厂传 refresher。
    expect(sqlite).toContain('refreshLaunchConfig: () => resolveLaunchRuntimeConfig(Paths.config)')
    // PostgreSQL：直接 new 的那台用 getter + 单一的 `currentRunConfig()`。
    expect(postgresql).toContain('const currentRunConfig = () =>')
    expect(postgresql).toContain('return resolveTaskDriveConfig(currentRunConfig())')
    // boot 那一刻的快照不许再被交给长驻协调器。
    expect(postgresql).not.toContain('runtime: resolveTaskDriveConfig(runConfig)')
  })
})
