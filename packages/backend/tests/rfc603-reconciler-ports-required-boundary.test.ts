// RFC-603 — development-automation 的 reconciler 端口必填（RFC-294 W4-E8：application 一侧按用例的必填端口）。
//
// 为什么存在：`ReconcilerPorts` 的 25 个成员原先都是可选的；生产装配一直给全（RFC-597 / 598 起在编译期就必须给全），“端口没给”只在用例里
// 出现。application 因此留着三类生产上走不到的分支：`*-not-wired` / `*-port-missing:*` 的 typed block、命令在没有端口时的失败结果、静默跳过
// （没有 playbook 台账就不进 playbook 编排、没有上传计划读取就按无计划处理……）。只给部分端口的用例走的是生产上不存在的路径。现在 25 个成员
// 都必填，命令与发布链只声明自己读的那几个（`Pick`），这些分支删去。锁四件事：
// ① 编译期：`ReconcilerPorts` 与各命令 / 发布链 deps 的端口没有可选键，这些 deps 的 `ports` 本身必填（判据带负对照）。
// ② 源码：`ReconcilerPorts` 恰好声明这 25 个成员，都没有 `?`。
// ③ 扫描 development-automation 的 application：不判断端口（及取自端口的局部变量）是否为 `undefined`，不对它们用 `?.` 或 `!`；删去的 code
//    不再作为字面量出现（判据带负对照，扫描文件数有下限）。
// ④ `reconcilerPortsFor` 给全 25 个键：5 个数据库支撑的端口按装配的做法工作，其余 20 个替身被调用即抛出带名字的错误。
//
// 覆盖范围（C12）：② ③ 读 application 源码，① 由 typecheck 执行，④ 跑 helper；行为由既有的 RFC-310 reconcile / 发布链 / 命令用例覆盖。
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import type { InvalidateActionDeps } from '@/modules/development-automation/application/actionInvalidation'
import type { MissionHandoverDeps } from '@/modules/development-automation/application/commands/missionHandover'
import type { ReopenDeps } from '@/modules/development-automation/application/commands/reopenMission'
import type { SubmitAnswersDeps } from '@/modules/development-automation/application/commands/submitMissionAnswers'
import type { adoptActiveMr } from '@/modules/development-automation/application/cutover'
import type { DeliveryChainPorts } from '@/modules/development-automation/application/missionDeliveryChain'
import type { loadPipelineManifest } from '@/modules/development-automation/application/pipelineEvidenceChain'
import type { ReconcilerPorts } from '@/modules/development-automation/application/ports/reconcilerPorts'
import { describeEachProvider } from './helpers/eachProvider'
import { reconcilerPortsFor } from './helpers/developmentAutomation'

const APPLICATION = join(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'development-automation',
  'application',
)
const PORTS_FILE = join(APPLICATION, 'ports', 'reconcilerPorts.ts')

const MEMBERS = [
  'actionBaseline',
  'actionTemplates',
  'actionWorkspace',
  'agentLauncher',
  'approvalGateway',
  'attemptContext',
  'candidateDelivery',
  'changeCandidate',
  'childMissions',
  'conflictMerge',
  'mergeRequestFacts',
  'mrEffects',
  'pipelineEvidence',
  'pipelineImport',
  'playbookSaga',
  'repoRemote',
  'repositoryFacts',
  'requirementMaterialize',
  'scriptLauncher',
  'uploadPlacement',
  'uploadPlanReader',
  'uploadPublication',
  'verificationExecution',
  'verificationProfiles',
  'workspaceValidation',
] as const
const DATABASE_BACKED = [
  'actionTemplates',
  'playbookSaga',
  'uploadPlanReader',
  'uploadPublication',
  'verificationProfiles',
] as const

/** Block / failure codes that only a missing port produced (RFC-603 design §1.3). */
const REMOVED_CODES = [
  'action-baseline-not-wired',
  'action-templates-not-wired',
  'action-workspace-not-wired',
  'agent-launcher-not-wired',
  'approval-gateway-not-wired',
  'attempt-context-not-wired',
  'change-candidate-not-wired',
  'child-mission-port-not-wired',
  'collector-not-wired:merge-request',
  'collector-not-wired:mr',
  'collector-not-wired:repository',
  'conflict-delivery-not-wired',
  'conflict-merge-discard-not-wired',
  'conflict-merge-not-wired',
  'placement-not-wired',
  'requirement-port-not-wired',
  'script-launcher-not-wired',
  'workspace-validation-not-wired',
]
const REMOVED_PREFIXES = [
  'delivery-port-missing:',
  'mr-care-port-missing:',
  'pipeline-port-missing:',
]

// ① Compile-time. An optional key makes the empty object fit its `Pick`.
type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never
}[keyof T]
type NoOptional<T> = [OptionalKeys<T>] extends [never] ? true : never
type IsRequired<T, K extends keyof T> = Record<never, never> extends Pick<T, K> ? never : true
const requiredPorts: [
  NoOptional<ReconcilerPorts>,
  NoOptional<DeliveryChainPorts>,
  IsRequired<InvalidateActionDeps, 'ports'>,
  NoOptional<InvalidateActionDeps['ports']>,
  IsRequired<SubmitAnswersDeps, 'ports'>,
  NoOptional<SubmitAnswersDeps['ports']>,
  IsRequired<MissionHandoverDeps, 'ports'>,
  NoOptional<MissionHandoverDeps['ports']>,
  IsRequired<ReopenDeps, 'ports'>,
  NoOptional<ReopenDeps['ports']>,
  NoOptional<Parameters<typeof adoptActiveMr>[0]['ports']>,
  NoOptional<Parameters<typeof loadPipelineManifest>[0]['ports']>,
] = [true, true, true, true, true, true, true, true, true, true, true, true]
// Negative controls: the helpers see an optional key.
const optionalSeen: OptionalKeys<{ readonly a?: 1; readonly b: 2 }> = 'a'
// @ts-expect-error — an optional key is not a required one
const optionalRequired: IsRequired<{ readonly a?: 1 }, 'a'> = true

const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

/** `ReconcilerPorts` members as `name` / `name?`. */
function declaredMembers(text: string): string[] {
  const source = parse(PORTS_FILE, text)
  const node = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === 'ReconcilerPorts',
  )
  return (node?.members ?? [])
    .map((member) => (member.name?.getText(source) ?? '') + (member.questionToken ? '?' : ''))
    .sort()
}

const MEMBER_SET: ReadonlySet<string> = new Set(MEMBERS)

/** `ports` / `x.ports`. */
function isPortsAccess(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === 'ports'
  return ts.isPropertyAccessExpression(node) && node.name.text === 'ports'
}

/** `ports.<member>` / `x.ports.<member>`. */
function isPortMemberAccess(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    MEMBER_SET.has(node.name.text) &&
    isPortsAccess(node.expression)
  )
}

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node

const isUndefined = (node: ts.Expression): boolean => {
  const inner = unwrap(node)
  return (
    (ts.isIdentifier(inner) && inner.text === 'undefined') ||
    (ts.isVoidExpression(inner) && ts.isNumericLiteral(inner.expression))
  )
}

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])

function enclosingFunction(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent
  while (current !== undefined && !ts.isFunctionLike(current) && !ts.isSourceFile(current))
    current = current.parent
  return current ?? node.getSourceFile()
}

/** Every place that treats a port (or a local taken from one) as possibly absent, and every removed code literal. */
function absenceFindings(path: string, text: string): string[] {
  const source = parse(path, text)
  const findings: string[] = []
  const at = (node: ts.Node, what: string) =>
    findings.push(
      `${path.split('/').slice(-2).join('/')}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${what}`,
    )
  // Locals initialised from a port, scoped to the function that declares them.
  const aliases: { readonly name: string; readonly scope: ts.Node }[] = []
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isPortMemberAccess(unwrap(node.initializer))
    )
      aliases.push({ name: node.name.text, scope: enclosingFunction(node) })
    ts.forEachChild(node, collect)
  }
  collect(source)
  const isAlias = (node: ts.Node): boolean =>
    ts.isIdentifier(node) &&
    aliases.some((alias) => {
      if (alias.name !== node.text) return false
      for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent)
        if (current === alias.scope) return true
      return false
    })
  const isPortLike = (node: ts.Node): boolean =>
    isPortsAccess(node) || isPortMemberAccess(node) || isAlias(node)
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node) ||
        ts.isCallExpression(node)) &&
      node.questionDotToken !== undefined &&
      isPortLike(unwrap(node.expression))
    )
      at(node, `optional chain on ${unwrap(node.expression).getText(source)}`)
    if (ts.isNonNullExpression(node) && isPortLike(unwrap(node.expression)))
      at(node, `non-null assertion on ${unwrap(node.expression).getText(source)}`)
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      const [left, right] = [unwrap(node.left), unwrap(node.right)]
      if ((isPortLike(left) && isUndefined(right)) || (isPortLike(right) && isUndefined(left)))
        at(node, `undefined check on ${(isUndefined(right) ? left : right).getText(source)}`)
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) {
      const value = node.text
      if (
        REMOVED_CODES.includes(value) ||
        REMOVED_PREFIXES.some((prefix) => value.startsWith(prefix))
      )
        at(node, `removed code ${value}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

function applicationFiles(): string[] {
  return readdirSync(APPLICATION, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

describe('RFC-603 —— reconciler 端口必填，命令与发布链只取自己读的端口', () => {
  test('编译期：ReconcilerPorts 与各 deps 的端口都必填', () => {
    expect(requiredPorts.every((value) => value)).toBe(true)
    expect([optionalSeen, optionalRequired as unknown]).toEqual(['a', true])
  })

  test('ReconcilerPorts 恰好是 25 个必填成员', () => {
    expect(declaredMembers(readFileSync(PORTS_FILE, 'utf8'))).toEqual([...MEMBERS])
  })

  test('application 不再把端口当作可能缺席，删去的 code 不再出现', () => {
    const files = applicationFiles()
    expect(files.length).toBeGreaterThanOrEqual(100)
    expect(files.flatMap((file) => absenceFindings(file, readFileSync(file, 'utf8')))).toEqual([])
  })

  test('负对照：各种缺席判断与删去的 code 都被认出，非端口的同形写法不算', () => {
    const probe = [
      'async function f(deps: D, ports: P, raw: unknown, options?: O) {',
      '  const store = deps.ports.playbookSaga',
      '  if (store === undefined) return null',
      '  const plan = await deps.ports.uploadPlanReader?.read("x")',
      '  await deps.ports.agentLauncher!.cancel("e")',
      '  if (ports.mrEffects === undefined) return',
      '  const handover = deps.ports?.mrEffects',
      '  if (undefined !== (deps.ports)) return',
      '  const port = ports.childMissions',
      '  await port?.observe({})',
      "  await deps.block('m', 'delivery-port-missing:repoRemote', null)",
      "  if (raw === undefined || selected.reason === 'mr-care-not-wired') return 'arm-not-wired:x'",
      '  const other = options?.mrEffects',
      '  return `agent-launcher-not-wired`',
      '}',
      'function g() {',
      '  const store = make()',
      '  if (store === undefined) return',
      '}',
    ].join('\n')
    expect(absenceFindings('/x/application/probe.ts', probe)).toEqual([
      'application/probe.ts:3 undefined check on store',
      'application/probe.ts:4 optional chain on deps.ports.uploadPlanReader',
      'application/probe.ts:5 non-null assertion on deps.ports.agentLauncher',
      'application/probe.ts:6 undefined check on ports.mrEffects',
      'application/probe.ts:7 optional chain on deps.ports',
      'application/probe.ts:8 undefined check on deps.ports',
      'application/probe.ts:10 optional chain on port',
      'application/probe.ts:11 removed code delivery-port-missing:repoRemote',
      'application/probe.ts:14 removed code agent-launcher-not-wired',
    ])
  })
})

describeEachProvider('provider', (harness) => {
  test('reconcilerPortsFor 给全 25 个端口：数据库支撑的按装配工作，其余替身调用即抛出带名字的错误', async () => {
    const ports = reconcilerPortsFor(harness.db)
    expect(Object.keys(ports).sort()).toEqual([...MEMBERS])
    expect([
      await ports.uploadPlanReader.read('missing-plan'),
      await ports.actionTemplates.content('missing-template', 1),
      await ports.verificationProfiles.content('missing-profile', 1),
      await ports.playbookSaga.listStepRuns('missing-mission'),
    ]).toEqual([null, null, null, []])
    expect(typeof ports.uploadPublication.record).toBe('function')
    const doubles = Object.entries(ports as unknown as Record<string, Record<string, unknown>>)
      .filter(([member]) => !(DATABASE_BACKED as readonly string[]).includes(member))
      .flatMap(([member, port]) =>
        Object.entries(port).map(([method, call]) => {
          try {
            ;(call as () => unknown)()
            return `${member}.${method}: returned`
          } catch (error) {
            return `${member}.${method}: ${(error as Error).message}`
          }
        }),
      )
    expect(doubles).toHaveLength(47)
    expect(doubles.filter((line) => !line.endsWith(' is not used by this test'))).toEqual([])
    const overridden = reconcilerPortsFor(harness.db, {
      repoRemote: { resolve: async () => null },
    })
    expect(await overridden.repoRemote.resolve('repo-1')).toBeNull()
  })
})
