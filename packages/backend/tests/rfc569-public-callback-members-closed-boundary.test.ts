// RFC-569 — public 合同上的四处回调成员与一处裸 typeof 收成闭合形状（RFC-294 S9 第二十四步）。
//
// 为什么存在：`PUBLIC_SURFACE_DEBT` 里有五条可以直接收成闭合形状，收完代码也更简单——修复路径的两个回调换成既有的
// `TaskLifecycleAlertNotices`；终态工作区回收策略与技能版本提交钩子变成只有方法的接口；需求文件视图继承下载句柄（不再重复声明两个打开方法）；
// “插件已停用”问题码有了具名的字面量类型。锁五件事：
// ① 五个声明里没有函数类型节点与类型查询（判据带负对照）。
// ② `applyRepair` 收 `notices`；修复路由与诊断路由传同一个对象。
// ③ 回收策略只有一个调用点，调的是 `decide`；两个实现都返回带 `decide` 的对象。
// ④ 行为：策略只在 `done` / `canceled` 被询问、抛错时不回收、结果原样交回；“永不回收”策略的结果。
// ⑤ 编译期断言：两个策略实现、文件视图、问题码与 `applyRepair` 入参的形状。
//
// 覆盖范围（C12）：① ② 只读点名的声明与文件；③ 覆盖 backend 全部生产源码；④ 是纯函数层的行为，修复路径把告警行的三个字段与解决的任务交给
// `notices` 由 `rfc359-w8-auto-repair-conformance` 覆盖，webhook 策略的判定由 `rfc370-terminal-workspace-policy-query` 等覆盖；⑤ 由 `tsc` 检查。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

import type { EvidenceDownloadHandle } from '../src/modules/development-automation/application/evidenceDownloads'
import type { DevelopmentMissionFileView } from '../src/modules/development-automation/application/missionOperations'
import type { createWebhookTerminalWorkspacePrunePolicy } from '../src/modules/integration/application/terminalWorkspaceCleanup'
import type {
  PLUGIN_DISABLED_ERROR_CODE,
  PluginDisabledErrorCode,
} from '../src/modules/resource-catalog/domain/disabledResourcePolicy'
import type { TaskLifecycleAlertNotices } from '../src/modules/task-execution/application/ports/taskDiagnostics'
import type {
  TerminalWorkspacePruneCandidate,
  TerminalWorkspacePrunePolicy,
} from '../src/modules/task-execution/domain/terminalWorkspacePrune'
import {
  neverPruneTerminalWorkspaces,
  resolveTerminalWorkspacePruneDecision,
} from '../src/modules/task-execution/infrastructure/terminalWorkspacePrune'
import type { TaskRouteOperations } from '../src/modules/task-execution/public/commands'

const SRC = resolve(import.meta.dir, '..', 'src')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** The named top-level interface / type alias of a source text. */
function declarationOf(path: string, text: string, name: string): ts.Node {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const found = source.statements.find(
    (statement) =>
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      statement.name.text === name,
  )
  if (found === undefined) throw new Error(`declaration ${name} not found in ${path}`)
  return found
}

/** The open nodes below a declaration: function types and type queries, as `<kind> <text>`. */
function openNodes(node: ts.Node): string[] {
  const source = node.getSourceFile()
  const out: string[] = []
  const visit = (child: ts.Node): void => {
    if (ts.isFunctionTypeNode(child) || ts.isTypeQueryNode(child))
      out.push(`${ts.SyntaxKind[child.kind]} ${child.getText(source).replace(/\s+/g, ' ')}`)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return out
}

/** The member of an interface declaration, by name. */
function memberOf(declaration: ts.Node, name: string): ts.Node {
  if (!ts.isInterfaceDeclaration(declaration)) throw new Error('not an interface')
  const found = declaration.members.find(
    (member) =>
      member.name !== undefined && ts.isIdentifier(member.name) && member.name.text === name,
  )
  if (found === undefined) throw new Error(`member ${name} not found`)
  return found
}

const CLOSED: ReadonlyArray<readonly [string, string]> = [
  ['modules/task-execution/domain/terminalWorkspacePrune.ts', 'TerminalWorkspacePrunePolicy'],
  ['modules/task-execution/domain/terminalWorkspacePrune.ts', 'TerminalWorkspacePruneCandidate'],
  ['modules/task-execution/application/ports/taskDiagnostics.ts', 'TaskLifecycleAlertNotices'],
  ['modules/resource-catalog/public/participants.ts', 'SkillVersionCommitHooks'],
  ['modules/development-automation/application/missionOperations.ts', 'DevelopmentMissionFileView'],
  ['modules/development-automation/application/evidenceDownloads.ts', 'EvidenceDownloadHandle'],
  ['modules/resource-catalog/public/types.ts', 'AgentResourceIssueCode'],
  ['modules/resource-catalog/domain/disabledResourcePolicy.ts', 'PluginDisabledErrorCode'],
]

// Compile-time: the shapes the declarations promise.
const neverPruneIsAPolicy: TerminalWorkspacePrunePolicy = neverPruneTerminalWorkspaces
const webhookPolicyIsAPolicy = (
  policy: ReturnType<typeof createWebhookTerminalWorkspacePrunePolicy>,
): TerminalWorkspacePrunePolicy => policy
const fileViewIsADownloadHandle = (view: DevelopmentMissionFileView): EvidenceDownloadHandle => view
const issueCodeIsTheConstantsType = (
  code: typeof PLUGIN_DISABLED_ERROR_CODE,
): PluginDisabledErrorCode => code
const constantIsTheIssueCode = (code: PluginDisabledErrorCode): typeof PLUGIN_DISABLED_ERROR_CODE =>
  code
const repairTakesTheNotices = (
  notices: TaskLifecycleAlertNotices,
): Parameters<TaskRouteOperations['applyRepair']>[0]['notices'] => notices
const noticesAreWhatRepairTakes = (
  notices: Parameters<TaskRouteOperations['applyRepair']>[0]['notices'],
): TaskLifecycleAlertNotices => notices

describe('RFC-569 —— 五个声明是闭合形状', () => {
  test('声明里没有函数类型节点与类型查询', () => {
    for (const [path, name] of CLOSED)
      expect([path, name, openNodes(declarationOf(path, read(path), name))]).toEqual([
        path,
        name,
        [],
      ])
    // The repair input on the route operations contract.
    const commands = 'modules/task-execution/public/commands.ts'
    const applyRepair = memberOf(
      declarationOf(commands, read(commands), 'TaskRouteOperations'),
      'applyRepair',
    )
    expect(openNodes(applyRepair)).toEqual([])
    const text = applyRepair.getText().replace(/\s+/g, ' ')
    expect(text).toContain('readonly notices: TaskLifecycleAlertNotices')
    expect(text).not.toMatch(/\bonAlert\b|\bonResolved\b/)
  })

  test('负对照：函数类型的属性、函数类型别名与 typeof 都会被认出；方法、字面量与具名类型不算', () => {
    const fixture =
      'export interface Hooks<R> { readonly before?: () => R; after?(versionIndex: number): R }\n' +
      'export type Policy = (row: Row, to: string) => Promise<Decision>\n' +
      "export type Code = 'a' | typeof CONSTANT | Named\n" +
      'export interface Closed { decide(row: Row, to: string): Promise<Decision>; readonly bytes: number }\n'
    expect(openNodes(declarationOf('probe.ts', fixture, 'Hooks'))).toEqual(['FunctionType () => R'])
    expect(openNodes(declarationOf('probe.ts', fixture, 'Policy'))).toEqual([
      'FunctionType (row: Row, to: string) => Promise<Decision>',
    ])
    expect(openNodes(declarationOf('probe.ts', fixture, 'Code'))).toEqual([
      'TypeQuery typeof CONSTANT',
    ])
    expect(openNodes(declarationOf('probe.ts', fixture, 'Closed'))).toEqual([])
  })

  test('文件视图只声明元数据，两个打开方法来自下载句柄；问题码常量标注成它的类型', () => {
    const missions = 'modules/development-automation/application/missionOperations.ts'
    const view = declarationOf(missions, read(missions), 'DevelopmentMissionFileView')
    if (!ts.isInterfaceDeclaration(view)) throw new Error('not an interface')
    expect(
      view.heritageClauses?.flatMap((clause) => clause.types.map((type) => type.getText())),
    ).toEqual(['EvidenceDownloadHandle'])
    expect(view.members.map((member) => member.name?.getText())).toEqual(['mediaType', 'bytes'])
    const policy = read('modules/resource-catalog/domain/disabledResourcePolicy.ts').split('\n')
    expect(policy).toContain(
      "export const PLUGIN_DISABLED_ERROR_CODE: PluginDisabledErrorCode = 'plugin-disabled'",
    )
    expect(policy).toContain("export type PluginDisabledErrorCode = 'plugin-disabled'")
  })
})

describe('RFC-569 —— 修复路径与诊断路径用同一个通知对象', () => {
  test('两条路由各传一次 LIFECYCLE_ALERT_NOTICES，修复路由不再拼回调', () => {
    const route = read('modules/task-execution/inbound/http/taskRoutes.ts')
    const lines = route.split('\n')
    expect(lines).toContain('        notices: LIFECYCLE_ALERT_NOTICES,')
    expect(lines).toContain(
      "      return c.json(await diagnostics.diagnose(c.req.param('id'), LIFECYCLE_ALERT_NOTICES))",
    )
    expect(route.split('LIFECYCLE_ALERT_NOTICES').length - 1).toBe(3)
    expect(route).not.toMatch(/\bonAlert\s*:|\bonResolved\s*:/)
    const repairs = read('modules/task-execution/infrastructure/taskRouteRepairOperations.ts')
    expect(repairs).toContain('const notices = input.notices')
    expect(repairs).toContain(
      'notices.alert({ taskId: row.taskId, rule: row.rule, severity: row.severity }, transition),',
    )
    expect(repairs).toContain('onResolved: (taskId) => notices.resolved(taskId),')
    expect(repairs).not.toContain('noticeCallback')
  })
})

describe('RFC-569 —— 回收策略只有一个调用点', () => {
  test('全部生产源码里，对策略的调用只有 resolveTerminalWorkspacePruneDecision 那一处', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThanOrEqual(3000)
    const calls = files.flatMap((path) => {
      const rel = slash(relative(SRC, path))
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => /\b(?:policy|terminalWorkspacePrune)\.decide\(/.test(line))
        .map((line) => `${rel}: ${line.trim()}`)
    })
    expect(calls).toEqual([
      'modules/task-execution/infrastructure/terminalWorkspacePrune.ts: return await policy.decide(row, to)',
    ])
    // Nothing calls the policy as a function any more.
    const direct = files.flatMap((path) => {
      const rel = slash(relative(SRC, path))
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => /\bterminalWorkspacePrune\(|\bawait policy\(/.test(line))
        .map((line) => `${rel}: ${line.trim()}`)
    })
    expect(direct).toEqual([])
  }, 120_000)

  test('两个实现都返回带 decide 的对象', () => {
    expect(read('modules/task-execution/infrastructure/terminalWorkspacePrune.ts')).toContain(
      'decide: async (): Promise<TerminalWorkspacePruneDecision> => ({ prune: false }),',
    )
    expect(read('modules/integration/application/terminalWorkspaceCleanup.ts')).toContain(
      '    async decide(row, to) {',
    )
  })
})

describe('RFC-569 —— 回收策略的行为', () => {
  const row: TerminalWorkspacePruneCandidate = {
    taskId: 'task-1',
    spaceKind: 'remote',
    workspacePruningAt: null,
    workspacePruneCause: null,
    workspacePrunedAt: null,
  }

  test('只在 done / canceled 询问策略，入参原样交给它，结果原样交回', async () => {
    const asked: unknown[] = []
    const policy: TerminalWorkspacePrunePolicy = {
      async decide(candidate, to) {
        asked.push([candidate, to])
        return { prune: true, cause: 'webhook-terminal' }
      },
    }
    for (const to of ['running', 'failed', 'interrupted', 'awaiting_review'] as const)
      expect(await resolveTerminalWorkspacePruneDecision(policy, row, to)).toEqual({ prune: false })
    expect(asked).toEqual([])
    expect(await resolveTerminalWorkspacePruneDecision(policy, row, 'done')).toEqual({
      prune: true,
      cause: 'webhook-terminal',
    })
    expect(await resolveTerminalWorkspacePruneDecision(policy, row, 'canceled')).toEqual({
      prune: true,
      cause: 'webhook-terminal',
    })
    expect(asked).toEqual([
      [row, 'done'],
      [row, 'canceled'],
    ])
  })

  test('策略抛错（同步抛或拒绝）时不回收', async () => {
    const rejecting: TerminalWorkspacePrunePolicy = {
      decide: async () => {
        throw new Error('corrupt config')
      },
    }
    const throwing: TerminalWorkspacePrunePolicy = {
      decide() {
        throw new Error('corrupt config')
      },
    }
    expect(await resolveTerminalWorkspacePruneDecision(rejecting, row, 'done')).toEqual({
      prune: false,
    })
    expect(await resolveTerminalWorkspacePruneDecision(throwing, row, 'canceled')).toEqual({
      prune: false,
    })
  })

  test('“永不回收”策略：不回收，对象冻结', async () => {
    expect(await neverPruneTerminalWorkspaces.decide(row, 'done')).toEqual({ prune: false })
    expect(await neverPruneTerminalWorkspaces.decide(row, 'canceled')).toEqual({ prune: false })
    expect(Object.isFrozen(neverPruneTerminalWorkspaces)).toBe(true)
  })

  test('形状对得上（编译期由 tsc 检查，这里留运行期锚点）', () => {
    expect(typeof neverPruneIsAPolicy.decide).toBe('function')
    for (const bind of [
      webhookPolicyIsAPolicy,
      fileViewIsADownloadHandle,
      issueCodeIsTheConstantsType,
      constantIsTheIssueCode,
      repairTakesTheNotices,
      noticesAreWhatRepairTakes,
    ])
      expect(typeof bind).toBe('function')
  })
})
