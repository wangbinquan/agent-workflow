import { execFileSync } from 'node:child_process'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import { workflows, users } from '@/db/schema'
import { composeDaemonFusionModules, type DaemonFusionModules } from '@/cli/daemonModules/fusion'
import { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import { createSqliteFusionEngineTaskOperations } from '@/modules/task-execution/infrastructure/fusionEngineTaskOperations'
import { createPostgresqlFusionEngineTaskOperations } from '@/modules/task-execution/infrastructure/postgresqlFusionEngineTaskOperations'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { composeMemoryCatalogOperations } from '@/modules/memory/composition'
import type {
  TaskDriveRequest,
  SchedulerDriverPort,
} from '@/modules/task-execution/application/ports/taskExecutionTopology'
import type { FusionWorkspaceEffects } from '@/modules/source-control/public/participants'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'
import { TEST_RESOURCE_SCOPE_AUTHORIZATION } from './helpers/resourceScopeAuthority'
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

  // RFC-382: all former root sites now share this one live getter.
  test('三个组合根里的每一台长驻协调器都接上了热读（枚举，不是点名）', () => {
    for (const relative of ['server.ts', 'cli/start.ts', 'cli/postgresqlDaemonApplication.ts']) {
      const source = readFileSync(resolve(ROOT, 'packages/backend/src', relative), 'utf8')
      expect(source).not.toMatch(/(?:createTaskDriveCoordinator|new DefaultTaskDriveCoordinator)\(/)
      expect(source.match(/composeDaemonTaskExecutionModules\(/g)).toHaveLength(1)
    }
    const bundle = readFileSync(
      resolve(ROOT, 'packages/backend/src/cli/daemonModules/taskExecution.ts'),
      'utf8',
    )
    expect(bundle.match(/createTaskDriveCoordinatorFactory\(/g)).toHaveLength(1)
    expect(bundle).toContain('const coordinator = coordinatorFactory.session')
    const factory = readFileSync(
      resolve(
        ROOT,
        'packages/backend/src/modules/task-execution/application/drive/taskDriveCoordinatorFactory.ts',
      ),
      'utf8',
    )
    expect(factory.match(/new DefaultTaskDriveCoordinator\(/g)).toHaveLength(1)
    expect(factory).toContain('get runtime()')
    expect(factory).toContain('const live = await options.runConfiguration()')
    expect(bundle).toContain('await taskLaunchConfiguration.start()')
  })
})

// RFC-381: the selected fusion adapters must read settings after composition on every launch.
describeEachProvider('RFC-381 CFG-45 fusion live configuration', (harness) => {
  for (const mode of ['local-sync', 'selected'] as const) {
    test(`${mode}: both real fusion adapters carry changed settings into the next scheduler drive`, async () => {
      const appHome = mkdtempSync(join(tmpdir(), 'rfc381-fusion-hot-'))
      try {
        const git = (...args: string[]) =>
          execFileSync('git', ['-C', appHome, ...args], { encoding: 'utf8' }).trim()
        git('init', '-q', '-b', 'fusion')
        git(
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--allow-empty',
          '-qm',
          'fusion fixture',
        )
        const configPath = join(appHome, 'config.json')
        writeFileSync(configPath, '{}')
        const ownerUserId = ulid(),
          workflowId = ulid()
        await harness.db.insert(users).values({
          id: ownerUserId,
          username: ownerUserId,
          displayName: 'Fusion',
          gitName: 'Fusion',
          email: 'fixture@example.test',
          role: 'admin',
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        })
        await harness.db.insert(workflows).values({
          id: workflowId,
          name: workflowId,
          definition: JSON.stringify({ $schema_version: 5, inputs: [], nodes: [], edges: [] }),
        })
        let current: Config = { ...DEFAULT_CONFIG, defaultRuntime: 'before', maxConcurrentNodes: 1 }
        const taskLaunchConfiguration = composeTaskLaunchConfiguration(
          mode === 'local-sync'
            ? { kind: 'local-sync', queries: { read: () => current } }
            : { kind: 'selected', queries: { read: async () => current } },
        )
        const driven: TaskDriveRequest[] = []
        const schedulerDriver: SchedulerDriverPort = {
          drive: async (request) => {
            driven.push(request)
          },
          cancelChild: async () => {},
          resumeChild: async () => {},
          isTaskActive: () => false,
        }
        const persistence = createTaskExecutionPersistence(harness.db)
        const binding = harness.applicationBinding
        const workspaces: FusionWorkspaceEffects = {
          prepare: async () => ({ worktreePath: appHome, baseCommit: git('rev-parse', 'HEAD') }),
          collect: async () => {
            throw new Error('unused fusion collection')
          },
          release: async () => {},
        }
        const tasks =
          binding.provider === 'sqlite'
            ? createSqliteFusionEngineTaskOperations({
                db: binding.db,
                appHome,
                schedulerDriver,
                workspaces,
                startDeps: {
                  configPath,
                  launchConfiguration: taskLaunchConfiguration.continuationQueries,
                },
              })
            : createPostgresqlFusionEngineTaskOperations({
                db: binding.db,
                appHome,
                schedulerDriver,
                workspaces,
                persistence,
                executionModule: createProviderTaskExecutionModule({
                  daemonGeneration: 'rfc381-fusion',
                  persistence,
                }),
                finalizeWorkspace: async () => {},
                log: createLogger('rfc381-fusion'),
                runConfiguration: () => fusionModules.runConfiguration(),
              })
        const fusionModules: DaemonFusionModules = composeDaemonFusionModules({
          db: harness.db,
          appHome,
          configPath,
          taskLaunchConfiguration,
          tasks,
          memories: composeMemoryCatalogOperations({
            db: harness.db,
            contexts: composeIdentityAccess(harness.db).contexts,
            authorization: TEST_RESOURCE_SCOPE_AUTHORIZATION,
          }),
        })
        for (const index of [1, 2]) {
          current = {
            ...current,
            defaultRuntime: `live-${index}`,
            defaultNodeRetries: index,
            sessionRestartBudget: index + 1,
            defaultPerNodeTimeoutMs: 9000 + index,
            maxConcurrentNodes: 3 + index,
            maxConcurrentScriptNodes: 4 + index,
            maxConcurrentCodeHostCalls: 5 + index,
            multiProcessSubprocessConcurrency: 6 + index,
            mergeAgentModel: `model-${index}`,
            mergeAgentRuntime: `merge-${index}`,
            subagentLiveCapture: { pollMs: 100 + index, consecutiveFailureLimit: index + 2 },
          }
          expect((await fusionModules.launchConfiguration.read()).defaultRuntime).toBe(
            `live-${index}`,
          )
          await fusionModules.fusionOperations.tasks.launch({
            taskId: ulid(),
            workflowId,
            name: `fusion ${index}`,
            inputs: {},
            ownerUserId,
            initiator: 'manual',
            fusionId: ulid(),
            iteration: index,
            seed: { base: [], overlay: null },
            platformInputPaths: [],
            awaitScheduler: true,
          })
          expect(driven).toHaveLength(index)
          expect(driven[index - 1]).toMatchObject({
            defaultRuntime: `live-${index}`,
            defaultNodeRetries: index,
            sessionRestartBudget: index + 1,
            defaultPerNodeTimeoutMs: 9000 + index,
            maxConcurrentNodes: 3 + index,
            maxConcurrentScriptNodes: 4 + index,
            maxConcurrentCodeHostCalls: 5 + index,
            multiProcessSubprocessConcurrency: 6 + index,
            mergeAgentModel: `model-${index}`,
            mergeAgentRuntime: `merge-${index}`,
            subagentLiveCapture: { pollMs: 100 + index, consecutiveFailureLimit: index + 2 },
          })
        }
      } finally {
        rmSync(appHome, { recursive: true, force: true })
      }
    }, 60_000)
  }
})

test('RFC-381 roots connect fusion adapters and routes to the same live session configuration', () => {
  const source = (file: string) =>
    readFileSync(resolve(ROOT, 'packages/backend/src', file), 'utf8').replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      '',
    )
  const bundle = source('cli/daemonModules/taskExecution.ts')
  expect(bundle).toContain('launchConfiguration: taskLaunchConfiguration.continuationQueries')
  expect(bundle).not.toContain('resolveLaunchRuntimeConfig')
  const pg = source('cli/postgresqlDaemonApplication.ts')
  expect(pg).toContain('fusionRunConfiguration: () => fusionModules.runConfiguration()')
  expect(bundle).toContain('runConfiguration: input.fusionRunConfiguration')
  expect(pg).toContain('launchConfiguration: fusionModules.launchConfiguration')
  const http = source('server.ts')
  expect(http).toContain('tasks: taskExecutionModules.fusion')
  expect(http).toContain('launchConfiguration: fusionLaunchConfiguration')
  expect(source('cli/daemonModules/fusion.ts')).toContain(
    'await input.taskLaunchConfiguration.start()',
  )
})
