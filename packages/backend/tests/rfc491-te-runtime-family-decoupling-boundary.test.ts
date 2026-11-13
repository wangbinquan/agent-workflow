// RFC-491 — task-execution 与运行时驱动一族互不 import（RFC-294 §4.7 运行时驱动一族第四步）。
//
// 锁七件事：
// ① task-execution 的全部生产文件不 import 运行时驱动一族（`services/runtime/**`、`services/execution/{agentInjection,
//    workspaceBoundary,taskExecutionResourceDependencies}`、`services/{driverLease,runtimeSmoke,systemAgentRun}`）。相对路径、
//    `@/` 别名、re-export、动态 import 与 type-only 都认，带负对照。
// ② 一族的全部文件不 import task-execution；两个一族运行器与两个只供契约用例的本机任务运行文件不在 `src/`，在 `tests/helpers/`。
// ③ 三个驱动静态事实只在 runtime-management 声明、经 `public/queries` 交出；task-execution 的四个使用方从那里取。
// ④ 声明清单的四个纯构造与它们的错误类只在 shared 声明一次；backend 里不再声明。
// ⑤ 启动清单读取与插件加载失败识别在 runtime-management，bootstrap 绑定；task-execution 不再声明它们。
// ⑥ 本机系统代理运行在 task-execution `infrastructure/local/`，不取 runtime-management 的内部与一族；MCP 诊断的本机执行体收
//    提供者；bootstrap 声明提供者与选择；两份 Windows 路径过滤登记新位置、不再列旧位置。
// ⑦ 行为（与驱动直取对拍）：三个查询、材料引用的来源计划形式、提供者就是 runtime-management 的同一组函数。
//
// 覆盖范围（C12）：① 读 task-execution 全部生产文件（语料下限 700）；② 读一族全部文件（下限 30）；③～⑥ 读指定文件与全部
// 生产文件里的同名声明；⑦ 单元。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import {
  getRuntimeDriver,
  isKnownRuntimeKind as familyIsKnownRuntimeKind,
} from '@/services/runtime'
import {
  detectRuntimeSessionNotFound,
  isKnownRuntimeKind,
  runtimeDriverCapabilities,
} from '@/modules/runtime-management/public/queries'
import {
  bindNativeAgentMaterialWorkspace,
  detectPluginLoadFailure,
  selectLocalAgentMaterialDefinition,
  selectNativeRuntimeDriver,
} from '@/modules/runtime-management/composition/localAgentMaterial'
import { bindNativeAgentMaterialReference } from '@/modules/runtime-management/infrastructure/local/agentMaterialCompiler'
import { detectPluginLoadFailure as pluginLoadFailureAtDeclaration } from '@/modules/runtime-management/infrastructure/local/pluginLoadDiagnostics'
import {
  localNativeSystemAgentRunProviders,
  localTaskAgentRunProviders,
} from '@/bootstrap/runFamilyProviders'

const SRC = resolve(import.meta.dir, '..', 'src')
const SHARED_SRC = resolve(SRC, '..', '..', 'shared', 'src')
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

const FAMILY_FILES = new Set([
  'services/execution/agentInjection',
  'services/execution/workspaceBoundary',
  'services/execution/taskExecutionResourceDependencies',
  'services/driverLease',
  'services/runtimeSmoke',
  'services/systemAgentRun',
])
function inFamily(target: string): boolean {
  const bare = target.replace(/\.[cm]?tsx?$/, '').replace(/\/index$/, '')
  return (
    bare === 'services/runtime' || bare.startsWith('services/runtime/') || FAMILY_FILES.has(bare)
  )
}
const familyImports = (path: string, text: string) =>
  specifiers(path, text)
    .filter(inFamily)
    .map((target) => `${path} -> ${target}`)
const taskExecutionImports = (path: string, text: string) =>
  specifiers(path, text)
    .filter((target) => target.startsWith('modules/task-execution/'))
    .map((target) => `${path} -> ${target}`)

/** Every identifier written in a file (comments and string contents excluded). */
function identifiersOf(path: string, text: string): Set<string> {
  const out = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) out.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, text))
  return out
}

/** Every production declaration of `name` (function, class, interface, type alias or const), as `src`-relative paths. */
function declarationsOf(name: string, files: readonly string[], root = SRC): string[] {
  return files.filter((path) => {
    // Backend files come from the shared text cache: ③～⑥ look up eleven names, each across ~3,200 production files.
    const text = root === SRC ? sourceText(path) : readFileSync(join(root, path), 'utf8')
    return (
      text.includes(name) &&
      parse(path, text).statements.some(
        (statement) =>
          ((ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement)) &&
            statement.name?.text === name) ||
          (ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
              (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
            )),
      )
    )
  })
}

const TASK_EXECUTION = filesOf('modules/task-execution')
const FAMILY = [
  ...filesOf('services/runtime'),
  ...[
    'services/execution/agentInjection.ts',
    'services/execution/workspaceBoundary.ts',
    'services/execution/taskExecutionResourceDependencies.ts',
    'services/driverLease.ts',
  ].filter((path) => existsSync(join(SRC, path))),
]
const PRODUCTION = filesOf('.')
const SHARED = walk(SHARED_SRC).map((path) => slash(relative(SHARED_SRC, path)))
const BINDINGS = 'bootstrap/runFamilyProviders.ts'
const NATIVE_RUN = 'modules/task-execution/infrastructure/local/nativeSystemAgentRun.ts'
const MCP_RUNNER = 'modules/task-execution/infrastructure/local/mcpDiagnosticRunner.ts'
const FACTS = 'modules/runtime-management/infrastructure/runtimeProtocolFacts.ts'

describe('RFC-491 ① task-execution 不 import 运行时驱动一族', () => {
  test('task-execution 的全部生产文件不取一族（语料下限 700）', () => {
    expect(TASK_EXECUTION.length).toBeGreaterThanOrEqual(700)
    expect(TASK_EXECUTION.flatMap((path) => familyImports(path, sourceText(path)))).toEqual([])
  })

  test('负对照：相对路径、别名、re-export、动态 import 与 type-only 都会被认出，一族之外的 services 不算', () => {
    const path = 'modules/task-execution/infrastructure/local/probe.ts'
    const text = [
      "import { getRuntimeDriver } from '../../../../services/runtime'",
      "import type { SpawnPlan } from '@/services/runtime/types'",
      "export { emptyDeclaredManifest } from '@/services/execution/agentInjection'",
      "const lazy = () => import('@/services/systemAgentRun')",
      "import type { SmokeOptions } from '../../../../services/runtimeSmoke'",
      "import { createDemoSeed } from '@/services/demoSeed'",
      "import { isKnownRuntimeKind } from '@/modules/runtime-management/public/queries'",
    ].join('\n')
    expect(familyImports(path, text)).toEqual([
      `${path} -> services/runtime`,
      `${path} -> services/runtime/types`,
      `${path} -> services/execution/agentInjection`,
      `${path} -> services/systemAgentRun`,
      `${path} -> services/runtimeSmoke`,
    ])
  })
})

describe('RFC-491 ② 一族不 import task-execution；两个运行器与两个本机任务运行文件移出生产', () => {
  test('一族的全部文件不取 task-execution（语料下限 30）', () => {
    expect(FAMILY.length).toBeGreaterThanOrEqual(30)
    expect(FAMILY.flatMap((path) => taskExecutionImports(path, sourceText(path)))).toEqual([])
  })

  test('负对照：一族文件取 task-execution 的别名与相对路径都会被认出', () => {
    const path = 'services/runtime/probe.ts'
    const text = [
      "import { bindNativeAgentInvocation } from '@/modules/task-execution/infrastructure/local/agentInvocation'",
      "import { runRuntimeSmokeCore } from '../../modules/task-execution/application/runtimeSmoke'",
      "import { RUNTIME_KINDS } from './index'",
    ].join('\n')
    expect(taskExecutionImports(path, text)).toEqual([
      `${path} -> modules/task-execution/infrastructure/local/agentInvocation`,
      `${path} -> modules/task-execution/application/runtimeSmoke`,
    ])
  })

  test('两个一族运行器与两个本机任务运行文件不在 src，在 tests/helpers', () => {
    for (const gone of [
      'services/runtimeSmoke.ts',
      'services/systemAgentRun.ts',
      'modules/task-execution/infrastructure/local/nativeTaskAgentRun.ts',
      'modules/task-execution/infrastructure/local/nativeTaskAgentRunOptions.ts',
      'modules/task-execution/infrastructure/local/nativeTaskAgentPluginLoadDiagnostics.ts',
      'modules/task-execution/infrastructure/local/taskRuntimeInventoryContent.ts',
    ])
      expect([gone, existsSync(join(SRC, gone))]).toEqual([gone, false])
    for (const helper of [
      'nativeRuntimeSmoke.ts',
      'nativeTaskAgentRun.ts',
      'nativeTaskAgentRunOptions.ts',
    ])
      expect([helper, existsSync(join(import.meta.dir, 'helpers', helper))]).toEqual([helper, true])
  })
})

describe('RFC-491 ③ 驱动静态事实经 runtime-management 的 public 查询', () => {
  test('三个查询只在 runtime-management 声明、经 public/queries 交出', () => {
    for (const name of ['runtimeDriverCapabilities', 'detectRuntimeSessionNotFound'])
      expect([name, declarationsOf(name, PRODUCTION)]).toEqual([name, [FACTS]])
    const queries = read('modules/runtime-management/public/queries.ts').replace(/\s+/g, ' ')
    expect(queries).toContain(
      "export { isKnownRuntimeKind, runtimeDriverCapabilities, detectRuntimeSessionNotFound, } from '../infrastructure/runtimeProtocolFacts'",
    )
  })

  test('task-execution 的四个使用方从 public/queries 取', () => {
    const consumers: Record<string, readonly string[]> = {
      'modules/task-execution/composition/nodeRunRuntime.ts': ['isKnownRuntimeKind'],
      'modules/task-execution/composition/agentNodeExecution.ts': ['detectRuntimeSessionNotFound'],
      'modules/task-execution/infrastructure/runtimeInventoryRead.ts': [
        'isKnownRuntimeKind',
        'runtimeDriverCapabilities',
      ],
      'modules/task-execution/infrastructure/crewstation/agentInvocationPreparation.ts': [
        'runtimeDriverCapabilities',
      ],
    }
    for (const [path, names] of Object.entries(consumers)) {
      const text = sourceText(path)
      const imported = parse(path, text)
        .statements.filter(
          (statement): statement is ts.ImportDeclaration =>
            ts.isImportDeclaration(statement) &&
            ts.isStringLiteral(statement.moduleSpecifier) &&
            statement.moduleSpecifier.text === '@/modules/runtime-management/public/queries',
        )
        .flatMap((statement) => {
          const bindings = statement.importClause?.namedBindings
          return bindings !== undefined && ts.isNamedImports(bindings)
            ? bindings.elements.map((element) => element.name.text)
            : []
        })
      expect([path, names.filter((name) => !imported.includes(name))]).toEqual([path, []])
      expect([path, identifiersOf(path, text).has('getRuntimeDriver')]).toEqual([path, false])
    }
  })
})

describe('RFC-491 ④ 声明清单的纯构造只在 shared', () => {
  test('四个构造与错误类只在 shared/src/declaredInjection.ts 声明；backend 不再声明', () => {
    for (const name of [
      'emptyDeclaredManifest',
      'partitionMcpsForInjection',
      'managedSkillsOf',
      'declareSkills',
      'AgentInjectionError',
      'McpInjectionPartition',
    ]) {
      expect([name, declarationsOf(name, SHARED, SHARED_SRC)]).toEqual([
        name,
        ['declaredInjection.ts'],
      ])
      expect([name, declarationsOf(name, PRODUCTION)]).toEqual([name, []])
    }
    expect(readFileSync(join(SHARED_SRC, 'index.ts'), 'utf8')).toContain(
      "export * from './declaredInjection'",
    )
  })
})

describe('RFC-491 ⑤ 两个本机实现在 runtime-management，bootstrap 绑定', () => {
  test('启动清单读取：runtime-management 声明并经 composition 交出，standalone 取它；task-execution 不再声明', () => {
    expect(declarationsOf('createLocalTaskRuntimeInventoryContent', PRODUCTION)).toEqual([
      'modules/runtime-management/infrastructure/local/taskRuntimeInventoryContent.ts',
    ])
    expect(read('modules/runtime-management/composition/taskRuntimeInventoryContent.ts')).toContain(
      "export { createLocalTaskRuntimeInventoryContent } from '../infrastructure/local/taskRuntimeInventoryContent'",
    )
    expect(read('bootstrap/standalone.ts')).toContain(
      "import { createLocalTaskRuntimeInventoryContent } from '@/modules/runtime-management/composition/taskRuntimeInventoryContent'",
    )
    expect(read('modules/task-execution/composition/taskRuntimeInventoryContent.ts')).not.toContain(
      'createLocalTaskRuntimeInventoryContent',
    )
  })

  test('插件加载失败识别：runtime-management 声明，本机任务代理族收提供者，bootstrap 绑定', () => {
    expect(declarationsOf('detectPluginLoadFailure', PRODUCTION)).toEqual([
      'modules/runtime-management/infrastructure/local/pluginLoadDiagnostics.ts',
    ])
    const family = sourceText('modules/task-execution/infrastructure/local/taskAgentRunFamily.ts')
    expect(family).toContain('return providers.pluginLoadFailures(')
    expect(read(BINDINGS)).toContain('pluginLoadFailures: detectPluginLoadFailure,')
    expect(localTaskAgentRunProviders.pluginLoadFailures).toBe(pluginLoadFailureAtDeclaration)
  })
})

describe('RFC-491 ⑥ 本机系统代理运行归 task-execution，提供者由 bootstrap 交入', () => {
  test('运行器在 task-execution 的 infrastructure/local，不取 runtime-management 内部与一族', () => {
    expect(declarationsOf('createNativeSystemAgentRun', PRODUCTION)).toEqual([NATIVE_RUN])
    for (const path of [NATIVE_RUN, MCP_RUNNER]) {
      const targets = specifiers(path, sourceText(path))
      expect([
        path,
        targets.filter(
          (target) =>
            target.startsWith('modules/runtime-management/') &&
            !target.startsWith('modules/runtime-management/public/'),
        ),
      ]).toEqual([path, []])
      expect([path, familyImports(path, sourceText(path))]).toEqual([path, []])
    }
  })

  test('MCP 诊断的本机执行体收提供者；bootstrap 声明提供者与选择，观测模块取选择', () => {
    const sf = parse(MCP_RUNNER, sourceText(MCP_RUNNER))
    const runner = sf.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === 'createLocalMcpDiagnosticRunner',
    )
    expect(runner?.parameters.map((parameter) => parameter.name.getText(sf))).toEqual([
      'input',
      'providers',
    ])
    expect(runner?.parameters.every((parameter) => parameter.questionToken === undefined)).toBe(
      true,
    )
    const bindings = read(BINDINGS)
    expect(bindings).toContain(
      'export const localNativeSystemAgentRunProviders: NativeSystemAgentRunProviders = Object.freeze({',
    )
    expect(bindings).toContain(
      'return createLocalMcpDiagnosticRunner(input, localNativeSystemAgentRunProviders)',
    )
    expect(read('bootstrap/daemonModules/observation.ts')).toContain(
      'execution: composeLocalMcpDiagnosticRunnerSelection(',
    )
  })

  test('两份 Windows 路径过滤登记新位置、不再列旧位置', () => {
    const workflow = readFileSync(
      resolve(SRC, '..', '..', '..', '.github', 'workflows', 'windows-platform.yml'),
      'utf8',
    )
    const listed = [...workflow.matchAll(/^\s*- '([^']+)'\s*$/gm)].map((match) => match[1]!)
    for (const path of [
      `packages/backend/src/${NATIVE_RUN}`,
      'packages/backend/tests/helpers/nativeRuntimeSmoke.ts',
      'packages/backend/tests/helpers/nativeTaskAgentRun.ts',
      'packages/backend/tests/helpers/nativeTaskAgentRunOptions.ts',
      'packages/backend/src/modules/runtime-management/infrastructure/local/pluginLoadDiagnostics.ts',
    ])
      expect([path, listed.filter((entry) => entry === path).length]).toEqual([path, 2])
    for (const gone of [
      'packages/backend/src/services/runtimeSmoke.ts',
      'packages/backend/src/services/systemAgentRun.ts',
      'packages/backend/src/modules/task-execution/infrastructure/local/nativeTaskAgentRun.ts',
      'packages/backend/src/modules/task-execution/infrastructure/local/nativeTaskAgentRunOptions.ts',
      'packages/backend/src/modules/task-execution/infrastructure/local/nativeTaskAgentPluginLoadDiagnostics.ts',
    ])
      expect([gone, listed.includes(gone)]).toEqual([gone, false])
  })
})

describe('RFC-491 ⑦ 行为与驱动直取一致', () => {
  const KINDS = ['opencode', 'claude-code'] as const

  test('种类判定与一族同一函数的结果相同', () => {
    for (const value of ['opencode', 'claude-code', 'codex', '', null, undefined])
      expect([value, isKnownRuntimeKind(value)]).toEqual([value, familyIsKnownRuntimeKind(value)])
  })

  test('驱动能力就是驱动的静态声明；未知种类同样抛错', () => {
    for (const kind of KINDS)
      expect(runtimeDriverCapabilities(kind)).toBe(getRuntimeDriver(kind).capabilities)
    expect(() => runtimeDriverCapabilities('codex' as never)).toThrow(
      "unknown runtime kind 'codex' — no registered driver",
    )
  })

  test('续会话目标不存在的判据与驱动的判断相同（命中、未命中、空串）', () => {
    const samples = [
      'Error: No conversation found with session ID: 0b3c',
      'error: session not found: ses_123',
      'unrelated stderr',
      '',
    ]
    for (const kind of KINDS)
      for (const stderr of samples)
        expect([kind, stderr, detectRuntimeSessionNotFound(kind, stderr)]).toEqual([
          kind,
          stderr,
          getRuntimeDriver(kind).detectSessionNotFound?.(stderr),
        ])
    expect(detectRuntimeSessionNotFound('claude-code', samples[0]!)).toBe(true)
    expect(detectRuntimeSessionNotFound('opencode', samples[1]!)).toBe(true)
  })

  test('材料引用的来源计划形式：包裹后的计划沿用原计划的引用', () => {
    for (const kind of KINDS) {
      const definition = selectLocalAgentMaterialDefinition(kind)
      const base = {}
      const wrapped = {}
      const baseRef = definition.materialReference(base)
      expect(definition.materialReference(wrapped, base)).toBe(baseRef)
      expect(definition.materialReference(wrapped)).toBe(baseRef)
      const lone = {}
      expect(definition.materialReference(lone)).toBe(bindNativeAgentMaterialReference(lone))
    }
  })

  test('bootstrap 交给本机系统代理运行的提供者就是 runtime-management 的同一组函数', () => {
    expect(localNativeSystemAgentRunProviders.drivers).toBe(selectNativeRuntimeDriver)
    expect(localNativeSystemAgentRunProviders.materialWorkspaces).toBe(
      bindNativeAgentMaterialWorkspace,
    )
    expect(localNativeSystemAgentRunProviders.materialDefinitions).toBe(
      selectLocalAgentMaterialDefinition,
    )
    for (const kind of KINDS) expect(selectNativeRuntimeDriver(kind)).toBe(getRuntimeDriver(kind))
    expect(detectPluginLoadFailure).toBe(pluginLoadFailureAtDeclaration)
  })
})
