// RFC-359 W5-T19b —— 四处组合根占位被拆掉之后，「没装配」在**类型层**不可表达的编译期锁。
//
// # 为什么这份用例主要是编译期断言
//
// 这四处拆的都是同一个形状：一个依赖在装配那一刻**允许缺席**（可选字段 / 可选构造参数 /
// 声明在收窄分支外的闭包），运行到某一行才 `throw new Error('…-not-composed')`。这种缺陷的
// 特征是**装配期不报错、类型上完全合法、单测各测各的也都绿**——W1-T1 修掉的那批 PG daemon
// `*-not-bound` 就是这样在生产上每个 tick 抛了很久（`design/dual-provider-parity-audit-2026-09-04.md`
// P0-7）。所以拆除之后能守住它的判据也只能在同一层：**那一格还接不接受缺席**。
//
// 因此下面用的是类型层断言（CI 的 `tsc --noEmit` 覆盖 `tests/`，所以它们是真门不是注释）：
// 一旦谁把某格改回可选，映射类型的值就从 `true` 变成那句中文错误串，赋值当场编译不过，
// 报错信息直接说明发生了什么。运行期那两条补的是「类型擦除之后属性是不是真的不在了」。
//
// # 本轮拆掉的四处（`tests/architecture/rfc359-w5-t19b-composition-root-complete.test.ts` 的账本同步减小）
//
//   · `modules/task-execution/composition/taskEngineApplication.ts` marker 11 → 2
//     `driveTaskEngineApplication` 的形参从 `RunTaskOptions`（九个装配依赖全可选 + 进门九句
//     `throw new Error('X-not-composed')` + 一次自我收窄）改成 `BoundRunTaskOptions`。
//     三个调用点（PG / SQLite 两个 runtime participants + 测试 topology）本来就逐个交齐，一字未改。
//   · `modules/task-execution/composition.ts` prose 1 → 0
//     `TaskExecutionModule.persistence?` 与 `claimPersisted` 进门那句
//     `'task-execution persistence is not composed'` 拆成两个类型：基类不再有空槽，
//     `claimPersisted` 只长在 `ProviderTaskExecutionModule` 上。
//   · `cli/package.ts` marker 1 → 0
//     `bootstrapFactory` 从可选变必填。它此前的代价是**实测过的**：`tests/rfc271-cli.test.ts`
//     的「--plan 与 --on-conflict 同时给 ⇒ 报错」本意走到「user not found」，却因为不传 factory
//     在「没装配」那一句就返回了，断言因一个无关理由变绿。必填之后那条用例才真的测它要测的东西。
//   · `modules/digital-employee/composition.ts` prose 1 → 0
//     `runtimeDocument` 的那句 throw 是**声明位置**造成的：它的 7 个使用点全在
//     `runtimeService === null ? null : {…}` 的非 null 分支里，只是它自己声明在分支外、
//     收窄够不着。改成显式接收已收窄的 service（`documentForCase`）即可。
//
// # 变异表（2026-09-07 落地实测）
//
// | # | 变异 | 结果 |
// |---|------|------|
// | ① | `BoundRunTaskOptions` 里把 `persistence` 改回可选 | `tsc --noEmit` 红：`Type 'boolean' is not assignable to type '"这一格又可以缺席了 …"'`（本文件第 1 条） |
// | ② | `claimPersisted` 挪回基类 `TaskExecutionModule` | `tsc --noEmit` 红（第 2 条）+ 运行期第 3 条红 |
// | ③ | `packageCommand` 的 `bootstrapFactory` 改回可选 | `tsc --noEmit` 红（第 4 条） |
// | ④ | 任一处把 throw 加回去（不改类型） | 本文件不红；由**账本**
//       `tests/architecture/rfc359-w5-t19b-composition-root-complete.test.ts` 红（它按 AST 数 marker/prose/holder）。两半分工如此。 |

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { packageCommand } from '@/cli/package'
import {
  createProviderTaskExecutionModule,
  createTaskExecutionTestModule,
  ProviderTaskExecutionModule,
  TaskExecutionModule,
} from '@/modules/task-execution/composition'
import type { driveTaskEngineApplication } from '@/modules/task-execution/composition/taskEngineApplication'
import type { SqliteTaskExecutionProviderRuntimeDependencies } from '@/modules/task-execution/composition/providerRuntime'
import type { createSqliteTaskExecutionRuntimeParticipants } from '@/modules/task-execution/infrastructure/sqliteTaskExecutionRuntimeParticipants'
import type { RunTaskOptions } from '@/services/execution/taskEngineRuntimeOptions'

const SRC = resolve(import.meta.dir, '..', 'src')

/**
 * 源码去掉整行注释后的样子。判据同架构账本里的那条（`rfc359-w5-t18-bare-transaction.test.ts`
 * 的 `isCommentLine`）：**拆除说明里必须能原样引用被拆掉的那句 throw**，否则注释自己会把
 * 断言弄红——本文件第一版就是这么红的，这段过滤是那次的产物。
 */
function code(rel: string): string {
  return readFileSync(resolve(SRC, rel), 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// 1. TaskEngine 驱动：九个装配依赖在参数类型上必填
// ---------------------------------------------------------------------------

type DriveOptions = Parameters<typeof driveTaskEngineApplication>[0]

/** 九个由 bootstrap 交齐的依赖。少任何一个都不该是合法的 drive 参数。 */
type ComposedDependencies = Pick<
  DriveOptions,
  | 'memoryInjectionQueries'
  | 'persistence'
  | 'runtimeSessionLeases'
  | 'runtimeRegistry'
  | 'taskDagCollaboration'
  | 'collaborationRuntime'
  | 'workgroupTurns'
  | 'childLaunch'
  | 'processConcurrencyScope'
  | 'identityAccess'
>

/**
 * 编译期判据：每一格都**不**接受 `undefined`。谁把某格改回可选，它的值类型就变成下面那句中文，
 * `true` 当场赋不进去，`tsc --noEmit` 直接把话说明白。
 */
type NoneMayBeAbsent = {
  [K in keyof ComposedDependencies]-?: undefined extends ComposedDependencies[K]
    ? '这一格又可以缺席了：drive 会带着一个没装配的依赖跑起来，缺口只在运行到它的那一行才炸'
    : true
}

const _noneMayBeAbsent: NoneMayBeAbsent = {
  memoryInjectionQueries: true,
  persistence: true,
  runtimeSessionLeases: true,
  runtimeRegistry: true,
  taskDagCollaboration: true,
  collaborationRuntime: true,
  workgroupTurns: true,
  childLaunch: true,
  processConcurrencyScope: true,
  identityAccess: true,
}

// W12: narrow the production contract without changing the outer legacy vocabulary.
const _sqliteIdentityRequired: undefined extends Parameters<
  typeof createSqliteTaskExecutionRuntimeParticipants
>[0]['identityAccess']
  ? 'SQLite runtime participants must receive the runtime during construction'
  : true = true
const _providerIdentityRequired: undefined extends SqliteTaskExecutionProviderRuntimeDependencies['runtime']['identityAccess']
  ? 'The full provider factory must not admit a missing runtime'
  : true = true
const _legacyIdentityStillOptional: undefined extends RunTaskOptions['identityAccess']
  ? true
  : 'Legacy run options must keep their existing optional input' = true

// ---------------------------------------------------------------------------
// 2. TaskExecution 模块：claimPersisted 只长在持久化交齐的那个类型上
// ---------------------------------------------------------------------------

const _baseHasNoClaimPersisted: 'claimPersisted' extends keyof TaskExecutionModule
  ? '基类又长出了 claimPersisted：那意味着它得在里面自己判空，「没装配」重新变得可表达'
  : true = true

const _providerHasClaimPersisted: 'claimPersisted' extends keyof ProviderTaskExecutionModule
  ? true
  : '装配齐的模块丢了 claimPersisted' = true

// ---------------------------------------------------------------------------
// 3. package CLI：bootstrap 工厂必填
// ---------------------------------------------------------------------------

const _factoryRequired: undefined extends Parameters<typeof packageCommand>[1]
  ? 'bootstrapFactory 又变可选了：命令会把「没装配」当成一种输出返回给用户'
  : true = true

// ---------------------------------------------------------------------------

describe('RFC-359 W5-T19b —— 组合根占位拆除后的运行期残迹', () => {
  test('未装配持久化的模块身上根本没有 claimPersisted 这个方法', () => {
    const module = createTaskExecutionTestModule('t19b')

    expect(
      (module as unknown as Record<string, unknown>)['claimPersisted'],
      'claimPersisted 又回到了基类原型上 —— 它一定得在里面判空，那句 throw 会跟着回来',
    ).toBeUndefined()
    expect(module).toBeInstanceOf(TaskExecutionModule)
    expect(module).not.toBeInstanceOf(ProviderTaskExecutionModule)
  })

  test('装配齐持久化的模块是同一棵继承树上的子类型，claim gate 等能力原样继承', () => {
    const persistence = {} as unknown as Parameters<
      typeof createProviderTaskExecutionModule
    >[0]['persistence']
    const module = createProviderTaskExecutionModule({
      daemonGeneration: 't19b-provider',
      persistence,
    })

    expect(module).toBeInstanceOf(ProviderTaskExecutionModule)
    expect(module).toBeInstanceOf(TaskExecutionModule)
    expect(typeof module.claimPersisted).toBe('function')
    expect(module.persistence).toBe(persistence)
    // 基类能力（claim gate / 进程内 runtime 注册表）不因为拆类型而丢。
    expect(module.claimGate).toBeDefined()
    expect(module.runtimeRegistry).toBeDefined()
  })

  test('四处占位的错误码 / 文案在源码里已无残迹（账本数计数，这里点名）', () => {
    const engine = code('modules/task-execution/composition/taskEngineApplication.ts')
    for (const marker of [
      'memory-injection-queries-not-composed',
      'task-execution-persistence-not-composed',
      'runtime-session-leases-not-composed',
      'runtime-registry-not-composed',
      'task-dag-collaboration-not-composed',
      'collaboration-runtime-mechanics-not-composed',
      'workgroup-turns-not-composed',
      'child-execution-launch-not-composed',
      'task-execution-concurrency-scope-not-composed',
      'identity-access-runtime-not-composed',
    ]) {
      expect(engine, `${marker} 回来了：drive 的形参又退回成「九个都可选」`).not.toContain(
        `'${marker}'`,
      )
    }

    expect(code('modules/task-execution/composition/nodeMechanics.ts')).not.toContain(
      'identity-access-runtime-not-composed',
    )

    expect(code('modules/task-execution/composition.ts'), '基类又开始自己判空持久化').not.toContain(
      'task-execution persistence is not composed',
    )
    expect(code('cli/package.ts'), 'package 命令又把「没装配」当成一种输出').not.toContain(
      'identity-access-runtime-not-composed',
    )
    expect(
      code('modules/digital-employee/composition.ts'),
      'runtimeDocument 又退回到分支外声明 + 进门判空',
    ).not.toContain('digital employee runtime is not composed')
  })
})
