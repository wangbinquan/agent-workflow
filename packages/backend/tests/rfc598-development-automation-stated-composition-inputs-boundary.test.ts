// RFC-598 — development-automation 的装配入参全部显式给出（RFC-294 S12 余项：装配不再有缺省）。
//
// 为什么存在：RFC-597 之后装配入参还有 6 个可选成员——三组效果选择（没给时 infrastructure 的 `select*` 造本机文件实现，只有用例靠它）与三个
// 证据读取的覆盖（RFC-429 起证据的读取、下载、文档与尝试上下文都是 `evidenceArtifacts` 的成员，生产从不给）。现在效果选择必填、三个覆盖删去，
// 只服务死选项的 `composition/evidenceReadBinding.ts` 一并删去。锁三件事：
// ① 装配入参的接口（连同继承的 provider 接口）没有带 `?` 的成员；编译期断言没有可选键（判据带负对照）。
// ② 装配不读 `deps.evidenceRead` / `deps.evidenceContents` / `deps.attemptContext`；三组效果选择只出现在核对它们的调用里、都不在条件或回落里；
//    `evidenceReadBinding.ts` 不在（谁再 import 它，`tsc` 报错）（判据带负对照）。
// ③ 测试助手：给了的原样交出；没给时与此前装配的回落相同——动作效果完整、自动化效果是它的 `contents`、基线效果是本机实现。
//
// 覆盖范围（C12）：① ② 只读模块装配文件；③ 跑助手。行为由调用装配的用例覆盖（它们都经这个助手）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import type { DevelopmentAutomationCompositionOptions } from '@/modules/development-automation/composition'
import { selectActionWorkspaceEffects } from '@/modules/development-automation/infrastructure/actionWorkspaceEffects'
import type { ActionWorkspaceEffects } from '@/modules/development-automation/application/ports/actionWorkspaceEffects'
import type { AutomationWorkspaceEffectsFactory } from '@/modules/development-automation/application/ports/automationWorkspaceEffects'
import type { RepositoryBaselineEffectsFactory } from '@/modules/development-automation/application/ports/repositoryBaselineEffects'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeStandaloneDevelopmentAutomationSelections } from './helpers/developmentAutomation'

const DA = join(import.meta.dir, '..', 'src', 'modules', 'development-automation')
const COMPOSITION = join(DA, 'composition.ts')
const INTERFACES = ['DevelopmentAutomationCompositionOptions', 'DevelopmentAutomationProviders']
const RETIRED = new Set(['evidenceRead', 'evidenceContents', 'attemptContext'])
const EFFECTS = new Set([
  'actionWorkspaceEffects',
  'automationWorkspaceEffects',
  'repositoryBaselines',
])

// ① Compile-time: an optional key makes the empty object fit its `Pick`, so this union is `never` only when none is optional.
type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never
}[keyof T]
const noOptionalInput: [OptionalKeys<DevelopmentAutomationCompositionOptions>] extends [never]
  ? true
  : never = true

const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

/** Members with `?` of the two input interfaces, as `Interface.member`. */
function optionalMembers(path: string, text: string): string[] {
  const source = parse(path, text)
  return source.statements
    .filter(
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && INTERFACES.includes(node.name.text),
    )
    .flatMap((node) =>
      node.members
        .filter((member) => member.questionToken !== undefined)
        .map((member) => `${node.name.text}.${member.name?.getText(source) ?? '?'}`),
    )
    .sort()
}

/** Whether a node sits in a condition, a fallback (`??` / `||`) or a comparison. */
function conditional(node: ts.Node): boolean {
  for (
    let child = node, parent = node.parent;
    parent !== undefined;
    child = parent, parent = parent.parent
  ) {
    if (ts.isConditionalExpression(parent) && parent.condition === child) return true
    if (ts.isIfStatement(parent) && parent.expression === child) return true
    if (
      ts.isBinaryExpression(parent) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(parent.operatorToken.kind)
    )
      return true
    if (ts.isStatement(parent)) return false
  }
  return false
}

/** Reads of `deps.<member>`: retired overrides, effect reads in a condition, and the call each effect read feeds. */
function inputReads(path: string, text: string) {
  const source = parse(path, text)
  const retired: string[] = []
  const conditionalEffects: string[] = []
  const effectCalls: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === 'deps') {
      const member = node.name.text
      if (RETIRED.has(member)) retired.push(member)
      if (EFFECTS.has(member)) {
        if (conditional(node)) conditionalEffects.push(member)
        const call = node.parent
        effectCalls.push(
          ts.isCallExpression(call) && call.arguments.includes(node)
            ? `${call.expression.getText(source)}(… deps.${member})`
            : `deps.${member} outside a call`,
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { retired, conditionalEffects, effectCalls: effectCalls.sort() }
}

describe('RFC-598 —— development-automation 的装配入参全部显式给出', () => {
  const text = readFileSync(COMPOSITION, 'utf8')

  test('装配入参（连同 provider 接口）没有可选成员', () => {
    expect(optionalMembers(COMPOSITION, text)).toEqual([])
    expect(noOptionalInput).toBe(true)
  })

  test('负对照：两个接口里带 ? 的成员都会被认出，别的接口不算', () => {
    expect(
      optionalMembers(
        'probe.ts',
        'export interface DevelopmentAutomationCompositionOptions {\n' +
          '  readonly appHome: string\n' +
          '  readonly attemptContext?: A\n' +
          '}\n' +
          'interface DevelopmentAutomationProviders {\n  readonly mrEffects?: B\n}\n' +
          'interface Other {\n  readonly optional?: C\n}\n',
      ),
    ).toEqual([
      'DevelopmentAutomationCompositionOptions.attemptContext',
      'DevelopmentAutomationProviders.mrEffects',
    ])
  })

  test('装配不读三个覆盖；三组效果选择只交给核对它们的调用；evidenceReadBinding.ts 不在', () => {
    expect(inputReads(COMPOSITION, text)).toEqual({
      retired: [],
      conditionalEffects: [],
      effectCalls: [
        'createActionBaselineResolver(… deps.repositoryBaselines)',
        'repositoryFactsScanFor(… deps.automationWorkspaceEffects)',
        'selectActionWorkspaceEffects(… deps.actionWorkspaceEffects)',
        'selectedAutomationWorkspaceEffects(… deps.automationWorkspaceEffects)',
      ],
    })
    expect(existsSync(join(DA, 'composition', 'evidenceReadBinding.ts'))).toBe(false)
  })

  test('负对照：覆盖读取、条件与回落里的效果选择、调用外的读取都会被认出', () => {
    expect(
      inputReads(
        'probe.ts',
        'const contents = deps.evidenceRead?.contents ?? deps.evidenceContents ?? evidence.contents\n' +
          'const factory = select(\n' +
          '  deps.automationWorkspaceEffects === undefined ? a.contents : deps.automationWorkspaceEffects,\n' +
          ')\n' +
          'const baselines = deps.repositoryBaselines ?? createLocal()\n' +
          'const context = { attemptContext: deps.attemptContext }\n',
      ),
    ).toEqual({
      retired: ['evidenceRead', 'evidenceContents', 'attemptContext'],
      conditionalEffects: ['automationWorkspaceEffects', 'repositoryBaselines'],
      effectCalls: [
        'deps.automationWorkspaceEffects outside a call',
        'deps.automationWorkspaceEffects outside a call',
        'deps.repositoryBaselines outside a call',
      ],
    })
  })

  test('测试助手：给了的原样交出；没给时与此前装配的回落相同', () => {
    const db = {} as PersistenceDb
    const appHome = join(import.meta.dir, 'never-created-rfc598')
    const given = {
      actionWorkspaceEffects: {} as ActionWorkspaceEffects,
      automationWorkspaceEffects: {} as AutomationWorkspaceEffectsFactory,
      repositoryBaselines: {} as RepositoryBaselineEffectsFactory,
    }
    // The other members are given too, so the helper builds nothing else (no evidence store, no admission lookup).
    const others = {
      requirementStaging: {} as never,
      evidenceArtifacts: {} as never,
      admissionLookup: {} as never,
    }
    const passed = composeStandaloneDevelopmentAutomationSelections({
      db,
      appHome,
      ...others,
      ...given,
    })
    expect(passed.actionWorkspaceEffects).toBe(given.actionWorkspaceEffects)
    expect(passed.automationWorkspaceEffects).toBe(given.automationWorkspaceEffects)
    expect(passed.repositoryBaselines).toBe(given.repositoryBaselines)
    const built = composeStandaloneDevelopmentAutomationSelections({ db, appHome, ...others })
    expect(selectActionWorkspaceEffects(built.actionWorkspaceEffects)).toBe(
      built.actionWorkspaceEffects,
    )
    expect(built.automationWorkspaceEffects).toBe(built.actionWorkspaceEffects.contents)
    expect(typeof built.repositoryBaselines.acquire).toBe('function')
    expect(existsSync(appHome)).toBe(false)
  })
})
