// RFC-489 — task-execution 的运行族不再取 runtime-management 内部（RFC-294 §4.7 运行时驱动一族第三步）。
//
// 锁六件事：
// ① task-execution 的全部生产文件对 runtime-management 只取 `public/`（唯一例外是实现 runtime-management 自有端口的
//    `application/adapters/runtime-management-adapter.ts` → `composition/required-ports`）；运行族的根不取 resource-catalog、
//    source-control 的 composition 与 infrastructure。相对路径、`@/` 别名、re-export、动态 import 与 type-only 都认，带负对照。
// ② 运行时管理的两个装配只在 runtime-management 的 composition 声明一次；task-execution 里不出现 runtime-management 的效果与绑定。
// ③ 本机探测族取材料定义的协议与运行证据：不取驱动、没有协议绑定提供者；`NativeProtocolBinding` 不再声明。
// ④ 本机调用不取 runtime-management 的 infrastructure：`bindNativeAgentInvocation` 收 `evidence` 与 `materialReference`，
//    材料定义的成员集合钉住。
// ⑤ bootstrap 绑定运行族的提供者：standalone、CrewStation 与部署档案取 `bootstrap/runFamilyProviders.ts`；task-execution 的
//    两个运行时管理根删除；`windows-platform.yml` 两份路径过滤登记新位置。
// ⑥ 行为（纯函数，与原构造对拍）：材料定义的运行证据与材料引用等于原构造；材料定义的协议与原手工协议绑定一致；运行时管理
//    装配把自己的诊断目标交给探测族、只交一次。
//
// 覆盖范围（C12）：① 读 task-execution 全部生产文件（语料下限 700）；②～⑤ 读指定文件与全部生产文件里的同名声明；⑥ 单元。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { getRuntimeDriver } from '@/modules/runtime-management/infrastructure/drivers'
import { bindNativeAgentProtocol } from '@/modules/runtime-management/infrastructure/local/agentProtocol'
import { bindNativeAgentMaterialReference } from '@/modules/runtime-management/infrastructure/local/agentMaterialCompiler'
import { createLocalAgentMaterialEvidence } from '@/modules/runtime-management/infrastructure/local/agentMaterialEvidence'
import { selectLocalAgentMaterialDefinition } from '@/modules/runtime-management/composition/localAgentMaterial'
import { composeLocalRuntimeManagement } from '@/modules/runtime-management/composition/localRuntimeManagement'

const SRC = resolve(import.meta.dir, '..', 'src')
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}
const filesOf = (dir: string) => walk(join(SRC, dir)).map((path) => slash(relative(SRC, path)))

const TEXTS = new Map<string, string>()
/** A production file's text, read once for all the whole-corpus scans below. */
function sourceText(path: string): string {
  let content = TEXTS.get(path)
  if (content === undefined) TEXTS.set(path, (content = read(path)))
  return content
}

/** Static and dynamic module specifiers of a file (type-only included), resolved to `src`-relative paths. */
function specifiers(path: string, text: string): string[] {
  const out: string[] = []
  const add = (specifier: string) =>
    out.push(
      specifier.startsWith('.')
        ? slash(relative(SRC, resolve(dirname(join(SRC, path)), specifier)))
        : specifier.startsWith('@/')
          ? specifier.slice(2)
          : specifier,
    )
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    )
      add(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, text))
  return out
}

/** The one non-public runtime-management target task-execution may import: implementing runtime-management's port. */
const ALLOWED_RM_INTERNAL = new Set([
  'modules/task-execution/application/adapters/runtime-management-adapter.ts -> modules/runtime-management/composition/required-ports',
])
function internalImports(path: string, text: string, contexts: readonly string[]): string[] {
  return specifiers(path, text)
    .map((target) => target.replace(/\.[cm]?tsx?$/, ''))
    .filter((target) =>
      contexts.some(
        (context) =>
          target.startsWith(`modules/${context}/`) &&
          !target.startsWith(`modules/${context}/public/`),
      ),
    )
    .map((target) => `${path} -> ${target}`)
    .filter((edge) => !ALLOWED_RM_INTERNAL.has(edge))
}

/** Every identifier written in a file (comments and string contents excluded). */
function identifiers(path: string, text: string): Set<string> {
  const out = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) out.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, text))
  return out
}

/**
 * Every production declaration of `name` (function, interface, type alias or exported const), as `src`-relative paths.
 * Only a file whose text contains `name` can declare it, so only those are parsed (docs/dev-gotchas.md, RFC-403 / RFC-487).
 */
function declarationsOf(name: string, files: readonly string[]): string[] {
  return files.filter(
    (path) =>
      sourceText(path).includes(name) &&
      parse(path, sourceText(path)).statements.some(
        (statement) =>
          ((ts.isFunctionDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement)) &&
            statement.name?.text === name) ||
          (ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
              (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
            )),
      ),
  )
}

const TASK_EXECUTION = filesOf('modules/task-execution')
const PRODUCTION = filesOf('.')
const ROOTS = [
  'modules/task-execution/composition/localRuntimeSmokeRunFamily.ts',
  'modules/task-execution/composition/localSystemAgentRunFamily.ts',
  'modules/task-execution/composition/crewstationSystemAgentRunFamily.ts',
  'modules/task-execution/composition/localTaskAgentRunFamily.ts',
]
const BINDINGS = 'bootstrap/runFamilyProviders.ts'
const SMOKE = 'modules/task-execution/infrastructure/local/runtimeSmokeRunFamily.ts'
const INVOCATION = 'modules/task-execution/infrastructure/local/agentInvocation.ts'
const PROVIDERS = 'modules/task-execution/infrastructure/local/nativeRunFamilyProviders.ts'

describe('RFC-489 ① task-execution 对 runtime-management 只取 public', () => {
  test('task-execution 的全部生产文件只经 public 取 runtime-management；运行族的根不取 resource-catalog、source-control 的内部', () => {
    expect(TASK_EXECUTION.length).toBeGreaterThanOrEqual(700)
    for (const root of ROOTS) expect(TASK_EXECUTION).toContain(root)
    expect(
      TASK_EXECUTION.flatMap((path) =>
        internalImports(path, sourceText(path), ['runtime-management']),
      ),
    ).toEqual([])
    expect(
      ROOTS.flatMap((path) =>
        internalImports(path, sourceText(path), ['resource-catalog', 'source-control']),
      ),
    ).toEqual([])
  })

  test('负对照：相对路径、别名、re-export、动态 import 与 type-only 都会被认出，public 与登记的端口实现不算', () => {
    const path = 'modules/task-execution/composition/probe.ts'
    const fixture = [
      "import { bindRuntimeManagement } from '../../runtime-management/composition/runtimeManagement'",
      "import type { X } from '@/modules/runtime-management/infrastructure/local/agentProtocol'",
      "export { y } from '@/modules/runtime-management/composition/localAgentMaterial'",
      "const later = () => import('@/modules/runtime-management/application/runtimeManagement')",
      "import type { RuntimeKind } from '@/modules/runtime-management/public/types'",
    ].join('\n')
    expect(internalImports(path, fixture, ['runtime-management'])).toEqual([
      `${path} -> modules/runtime-management/composition/runtimeManagement`,
      `${path} -> modules/runtime-management/infrastructure/local/agentProtocol`,
      `${path} -> modules/runtime-management/composition/localAgentMaterial`,
      `${path} -> modules/runtime-management/application/runtimeManagement`,
    ])
    const adapter = 'modules/task-execution/application/adapters/runtime-management-adapter.ts'
    expect(
      internalImports(
        adapter,
        "import type { P } from '@/modules/runtime-management/composition/required-ports'",
        ['runtime-management'],
      ),
    ).toEqual([])
  })
})

describe('RFC-489 ② 运行时管理由 runtime-management 自己装配', () => {
  test('两个装配只在 runtime-management 的 composition 声明一次；task-execution 不出现它的效果与绑定', () => {
    expect(declarationsOf('composeLocalRuntimeManagement', PRODUCTION)).toEqual([
      'modules/runtime-management/composition/localRuntimeManagement.ts',
    ])
    expect(declarationsOf('composeCrewStationRuntimeManagement', PRODUCTION)).toEqual([
      'modules/runtime-management/composition/crewstationRuntimeManagement.ts',
    ])
    const forbidden = [
      'bindRuntimeManagement',
      'composeRuntimeManagement',
      'createLocalRuntimeManagementEffects',
      'createCrewStationRuntimeManagementEffects',
      'createLocalRuntimeDiagnosticTargets',
    ]
    expect(
      TASK_EXECUTION.flatMap((path) => {
        const text = sourceText(path)
        if (!forbidden.some((name) => text.includes(name))) return []
        const names = identifiers(path, text)
        return forbidden.filter((name) => names.has(name)).map((name) => `${path}: ${name}`)
      }),
    ).toEqual([])
    for (const deleted of [
      'modules/task-execution/composition/localRuntimeManagement.ts',
      'modules/task-execution/composition/crewstationRuntimeManagement.ts',
    ])
      expect([deleted, existsSync(join(SRC, deleted))]).toEqual([deleted, false])
  })
})

describe('RFC-489 ③④ 本机探测族与本机调用只用材料定义', () => {
  test('本机探测族不取驱动、没有协议绑定提供者，协议与运行证据取自材料定义', () => {
    const names = identifiers(SMOKE, sourceText(SMOKE))
    for (const forbidden of ['getRuntimeDriver', 'bindProtocol', 'NativeProtocolBinding'])
      expect([forbidden, names.has(forbidden)]).toEqual([forbidden, false])
    const compact = sourceText(SMOKE).replace(/\s+/g, ' ')
    for (const member of [
      'protocol: definition.protocol,',
      'evidence: definition.evidence,',
      'materialReference: definition.materialReference,',
    ])
      expect(compact).toContain(member)
    expect(declarationsOf('NativeProtocolBinding', PRODUCTION)).toEqual([])
  })

  test('本机调用收 evidence 与 materialReference；材料定义的成员集合钉住', () => {
    expect(
      specifiers(INVOCATION, sourceText(INVOCATION)).filter(
        (target) =>
          target.startsWith('modules/runtime-management/') &&
          !target.startsWith('modules/runtime-management/public/'),
      ),
    ).toEqual([])
    const sf = parse(INVOCATION, sourceText(INVOCATION))
    const bind = sf.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'bindNativeAgentInvocation',
    )
    const input = bind?.parameters[0]?.type
    expect(input !== undefined && ts.isTypeLiteralNode(input)).toBe(true)
    const members = new Set(
      (input as ts.TypeLiteralNode).members.map((member) => member.name?.getText(sf)),
    )
    expect(members.has('evidence')).toBe(true)
    expect(members.has('materialReference')).toBe(true)
    expect(members.has('evidenceHooks')).toBe(false)
    expect(members.has('evidenceScope')).toBe(false)
    const providers = parse(PROVIDERS, sourceText(PROVIDERS))
    const definition = providers.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === 'NativeMaterialDefinition',
    )
    expect(definition?.members.map((member) => member.name?.getText(providers)).sort()).toEqual([
      'createCompiler',
      'evidence',
      'materialReference',
      'protocol',
    ])
  })
})

describe('RFC-489 ⑤ bootstrap 绑定运行族的提供者', () => {
  test('提供者与选择在 bootstrap 声明一次；standalone、CrewStation 与部署档案取它们', () => {
    for (const name of [
      'localRuntimeSmokeRunProviders',
      'localSystemAgentRunProviders',
      'localTaskAgentRunProviders',
      'composeLocalSystemAgentRunFamilySelection',
      'composeLocalRuntimeManagementSelection',
      'composeCrewStationRunFamilySelections',
    ])
      expect([name, declarationsOf(name, PRODUCTION)]).toEqual([name, [BINDINGS]])
    const standalone = read('bootstrap/standalone.ts').replace(/\s+/g, ' ')
    expect(standalone).toContain('runtimeManagement: composeLocalRuntimeManagementSelection,')
    expect(standalone).toContain('systemAgentRunFamily: composeLocalSystemAgentRunFamilySelection,')
    expect(standalone).toContain('taskAgentProviders: localTaskAgentRunProviders,')
    expect(read('bootstrap/crewstation.ts')).toContain(
      '...composeCrewStationRunFamilySelections(execution.hostedAgents),',
    )
    const profile = read('bootstrap/deploymentProfile.ts')
    expect(profile).toContain(
      'readonly runtimeManagement: typeof composeLocalRuntimeManagementSelection',
    )
    expect(profile).toContain(
      'readonly systemAgentRunFamily: typeof composeLocalSystemAgentRunFamilySelection',
    )
    const execution = read('modules/task-execution/composition/crewstationExecution.ts')
    expect(execution).not.toContain('systemAgentRunFamily:')
    expect(execution).not.toContain('runtimeManagement:')
  })

  test('windows-platform 的两份路径过滤登记运行时管理链的新位置、不再列删除的根', () => {
    const workflow = readFileSync(
      resolve(SRC, '..', '..', '..', '.github', 'workflows', 'windows-platform.yml'),
      'utf8',
    )
    const listed = [...workflow.matchAll(/^\s*- '([^']+)'\s*$/gm)].map((match) => match[1]!)
    for (const path of [
      'modules/runtime-management/composition/localRuntimeManagement.ts',
      BINDINGS,
    ]) {
      expect(existsSync(join(SRC, path))).toBe(true)
      expect([
        path,
        listed.filter((entry) => entry === `packages/backend/src/${path}`).length,
      ]).toEqual([path, 2])
    }
    expect(
      listed.filter((entry) =>
        entry.endsWith('task-execution/composition/localRuntimeManagement.ts'),
      ),
    ).toEqual([])
  })
})

describe('RFC-489 ⑥ 行为与原构造一致', () => {
  const scope = {
    environment: () => ({ SELECTED: 'env' }),
    runContent: () => '/selected-run',
    sessionLocation: () => ({ worktreePath: '/selected-working' }),
  }

  test('材料定义的运行证据与材料引用等于原构造（驱动的钩子加运行的 scope；计划的引用）', () => {
    for (const kind of ['opencode', 'claude-code'] as const) {
      const definition = selectLocalAgentMaterialDefinition(kind)
      const evidence = definition.evidence(scope)
      const original = createLocalAgentMaterialEvidence({ hooks: getRuntimeDriver(kind), scope })
      for (const member of [
        'prepareUsageMeter',
        'readInventory',
        'drainFinalEvents',
        'startLiveCapture',
        'captureSessionsToSink',
      ] as const)
        expect([kind, member, typeof evidence[member]]).toEqual([
          kind,
          member,
          typeof original[member],
        ])
      expect(typeof evidence.captureSessions).toBe('function')
      const plan = {}
      expect(definition.materialReference(plan)).toBe(bindNativeAgentMaterialReference(plan))
      expect(definition.materialReference(plan)).toBe(definition.materialReference(plan))
    }
  })

  test('材料定义的协议与原手工协议绑定一致（探测族此前自己做的那一份）', () => {
    for (const kind of ['opencode', 'claude-code'] as const) {
      const driver = getRuntimeDriver(kind)
      const selected = selectLocalAgentMaterialDefinition(kind).protocol
      const original = bindNativeAgentProtocol(driver)
      expect(selected.kind).toBe(original.kind)
      expect(selected.capabilities).toBe(original.capabilities)
      for (const member of [
        'usageMeter',
        'observeSystemEvent',
        'parseTerminalResultError',
      ] as const)
        expect([kind, member, typeof selected[member]]).toEqual([
          kind,
          member,
          typeof original[member],
        ])
      const outcome = (protocol: typeof original, line: string) => {
        try {
          return { value: protocol.parseEvent(line) }
        } catch (error) {
          return { error: String(error) }
        }
      }
      for (const line of ['{"type":"step_start"}', 'not json', ''])
        expect(outcome(selected, line)).toEqual(outcome(original, line))
    }
  })

  test('运行时管理装配把自己的诊断目标交给探测族，只交一次', () => {
    const received: unknown[] = []
    const management = composeLocalRuntimeManagement({
      configuration: {
        current: () => ({}),
        withProbeReceiptFence: (action) => action(),
      },
      runtimeRegistry: new Proxy(
        {} as Parameters<typeof composeLocalRuntimeManagement>[0]['runtimeRegistry'],
        {
          get() {
            throw new Error('composition must not read the registry')
          },
        },
      ),
      runtimeTests: { reconcileDurableIntents: async () => undefined },
      smoke(targets) {
        received.push(targets)
        return { run: async () => ({ ok: false }) as never }
      },
    })
    expect(received).toHaveLength(1)
    const targets = received[0] as { capture?: unknown; runtimeBinding?: unknown }
    expect(typeof targets.capture).toBe('function')
    expect(typeof targets.runtimeBinding).toBe('function')
    expect(Object.keys(management).sort()).toEqual([
      'configuration',
      'models',
      'observations',
      'runtimes',
    ])
  })
})
