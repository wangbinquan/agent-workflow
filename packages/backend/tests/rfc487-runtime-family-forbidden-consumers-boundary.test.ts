// RFC-487 — 运行时驱动一族的 DAG 外使用方改经各自的端口（RFC-294 §4.7 运行时驱动一族第一步）。
//
// 锁五件事：
// ① memory、resource-catalog、source-control、system-operations 的全部生产文件不 import 运行时驱动一族（`services/runtime/**` 与
//    `services/execution/{agentInjection,workspaceBoundary,taskExecutionResourceDependencies}`、`services/{driverLease,runtimeSmoke,
//    systemAgentRun}`）；相对路径、`@/` 别名、re-export 与动态 import 都认，带负对照。按 RFC-294 design §3.1 这四个 context 不消费
//    runtime-management，一族迁入后这些 import 会成为越 DAG 的值边。RFC-487 时唯一的例外是 resource-catalog 本机 MCP 诊断的
//    执行体（三条边逐条钉住）；RFC-488 把它的运行时工作移到 task-execution 实现的端口后，四个 context 都是零。
// ② memory 不再读 runtime-management 的 `runtimes` 表，复制的解析器删除；memory 的装配从输入取 `runtimeProfiles`，bootstrap 用
//    runtime-management 的 `resolveInternalAgentRuntime` 绑定（RFC-117 的内部代理解析只留一份）。
// ③ 本机 doctor 经注入的 `DoctorRuntimeBinaryProbe` 探测；bootstrap 的 doctor 工厂与 standalone 的软探测都取 runtime-management 的
//    `composeDefaultRuntimeBinaryProbe`。探测链换了文件，`windows-platform.yml` 的两份路径过滤都登记新位置（bootstrap 的绑定与
//    默认二进制探测），改动它们仍会触发 Windows 上的 doctor 用例（同 RFC-473 的登记做法）。
// ④ `resolveBoundaryMounts` 只在 source-control 的 domain 声明、经 `public/queries` 交出；`SkillSource`、`NativeSkillContent`、
//    `RuntimePlugin` 只在 resource-catalog 的 domain 声明、经 `public/types` 交出；一族的 `ResolvedSkill` 只在一族声明一次，扩展
//    `NativeSkillContent`、只加驱动侧的 `readContentVersion`（public 合同只放数据，不放函数）；一族的其余原位置只剩类型转出。
// ⑤ 行为（两种 provider）：memory 经 bootstrap 形状的绑定解析四种输入，结果与此前 memory 自己的解析一致；doctor 的 `probeRuntime`
//    把配置的 opencode 路径原样交给注入的探测、原样返回探测结果。
//
// 覆盖范围（C12）：① 读四个 context 的全部生产文件（语料下限 600）；②③④ 读指定文件与全部生产文件里的同名声明。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { createLocalDoctorDiagnosticsFactory } from '@/modules/system-operations/composition/localDoctorDiagnostics'
import type { DoctorRuntimeBinaryProbe } from '@/modules/system-operations/application/ports/doctorDiagnostics'
import { composeSystemOperationsTaskPorts } from '@/modules/task-execution/composition'
import { distillRuntimeProfile } from '@/modules/memory/application/distill/distillRuntimeProfile'
import { describeEachProvider } from './helpers/eachProvider'
import { runtimeManagementDistillRuntimes } from './helpers/memoryDistill'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'

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

/** Static and dynamic module specifiers of a file, relative ones resolved to `src`-relative paths. */
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
function familyImports(path: string, text: string): string[] {
  return specifiers(path, text)
    .filter(inFamily)
    .map((target) => `${path} -> ${target}`)
}

/** `runtimes` read through the session tables: a destructured binding or a property access named `runtimes`. */
function runtimesTableReads(path: string, text: string): string[] {
  const out: string[] = []
  const sf = parse(path, text)
  const visit = (node: ts.Node) => {
    if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(sf) === 'runtimes')
      out.push(`${path}: binding runtimes`)
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'runtimes')
      out.push(`${path}: ${node.getText(sf)}`)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

const TEXTS = new Map<string, string>()
/** A production file's text, read once for all the whole-corpus declaration scans below. */
function sourceText(path: string): string {
  let content = TEXTS.get(path)
  if (content === undefined) TEXTS.set(path, (content = read(path)))
  return content
}

/**
 * Every production declaration of `name` (function, interface or type alias), as `src`-relative paths. Only a file whose
 * text contains `name` can declare it, so only those are parsed: one AST pass over the whole corpus per name exceeds
 * bun's default 5 s on a loaded runner (docs/dev-gotchas.md, RFC-403).
 */
function declarationsOf(name: string, files: readonly string[]): string[] {
  return files.filter(
    (path) =>
      sourceText(path).includes(name) &&
      parse(path, sourceText(path)).statements.some(
        (statement) =>
          (ts.isFunctionDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement)) &&
          statement.name?.text === name,
      ),
  )
}

/** Names a file re-exports from `from` (`export { … } from` / `export type { … } from`). */
function reExportsFrom(path: string, from: string): string[] {
  const names: string[] = []
  for (const statement of parse(path, read(path)).statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== from ||
      statement.exportClause === undefined ||
      !ts.isNamedExports(statement.exportClause)
    )
      continue
    for (const element of statement.exportClause.elements) names.push(element.name.text)
  }
  return names.sort()
}

const CONSUMERS = ['memory', 'resource-catalog', 'source-control', 'system-operations'] as const
const CONSUMER_FILES = CONSUMERS.flatMap((context) => filesOf(`modules/${context}`))
const PRODUCTION = filesOf('.')

describe('RFC-487 ① DAG 外的四个 context 不取运行时驱动一族', () => {
  test('四个 context 的全部生产文件不 import 一族（RFC-488 起本机 MCP 诊断执行体也是零）', () => {
    expect(CONSUMER_FILES.length).toBeGreaterThanOrEqual(600)
    expect(CONSUMER_FILES.flatMap((path) => familyImports(path, read(path))).sort()).toEqual([])
  })

  test('负对照：相对路径、别名、re-export 与动态 import 都会被认出', () => {
    const path = 'modules/source-control/infrastructure/local/probe.ts'
    const fixture = [
      "import { resolveBoundaryMounts } from '@/services/execution/workspaceBoundary'",
      "import { getRuntimeDriver } from '../../../../services/runtime'",
      "import type { ResolvedSkill } from '@/services/runtime/types'",
      "export { runSystemAgent } from '@/services/systemAgentRun'",
      "const later = () => import('@/services/runtime/index')",
      "import { resolveBoundaryMounts as ok } from '../../domain/taskAgentMounts'",
      "import type { RuntimeKind } from '@/modules/runtime-management/public/types'",
      "import { notFamily } from '@/services/mergeAgent'",
    ].join('\n')
    expect(familyImports(path, fixture)).toEqual([
      `${path} -> services/execution/workspaceBoundary`,
      `${path} -> services/runtime`,
      `${path} -> services/runtime/types`,
      `${path} -> services/systemAgentRun`,
      `${path} -> services/runtime/index`,
    ])
  })
})

describe('RFC-487 ② memory 的蒸馏运行时解析经 runtime-management', () => {
  const MEMORY = filesOf('modules/memory')

  test('复制的解析器已删除，memory 不读 runtimes 表', () => {
    expect(
      existsSync(join(SRC, 'modules/memory/infrastructure/memoryDistillRuntimeResolver.ts')),
    ).toBe(false)
    expect(MEMORY.flatMap((path) => runtimesTableReads(path, read(path)))).toEqual([])
    expect(
      runtimesTableReads(
        'probe.ts',
        'const { runtimes } = tablesOf(db)\nawait db.select().from(tables.runtimes)',
      ),
    ).toEqual(['probe.ts: binding runtimes', 'probe.ts: tables.runtimes'])
  })

  test('memory 的装配从输入取 runtimeProfiles，bootstrap 用 resolveInternalAgentRuntime 绑定', () => {
    const composition = read('modules/memory/composition.ts')
    expect(composition).toContain('readonly runtimeProfiles: NativeMemoryDistillRuntimeResolver')
    expect(composition).toContain('const nativeRuntimeResolver = input.runtimeProfiles')
    expect(composition).not.toContain('DrizzleMemoryDistillRuntimeResolver')
    expect(read('bootstrap/daemonApplication.ts')).toMatch(
      /runtimeProfiles: \{\s*resolve: \(request\) => core\.runtimeRegistry\.resolveInternalAgentRuntime\(request\),\s*\}/,
    )
  })

  test('memory 只保留端口声明的运行时字段（runtime-management 的解析是超集），蒸馏运行不变', () => {
    const identity = {
      registrationId: 'rfc487-r',
      configurationRevision: 3,
      acceptedName: 'rfc487',
    }
    const registered = {
      name: 'rfc487',
      protocol: 'claude-code' as const,
      binaryPath: null,
      configDir: { env: 'CLAUDE_CONFIG_DIR', name: '.claude' },
      model: 'rfc487-model',
      variant: 'rfc487-variant',
      temperature: 0.4,
      steps: 7,
      maxSteps: 9,
      isSandbox: true,
      extraArgs: ['--rfc487'],
      observationIdentity: identity,
    }
    expect(distillRuntimeProfile(registered)).toEqual({
      protocol: 'claude-code',
      binaryPath: null,
      model: 'rfc487-model',
      isSandbox: true,
      observationIdentity: identity,
    })
    const builtin = {
      name: 'opencode',
      protocol: 'opencode' as const,
      binaryPath: null,
      configDir: { env: 'OPENCODE_CONFIG_DIR', name: '.opencode' },
      model: null,
      variant: null,
      isSandbox: false,
    }
    expect(Object.keys(distillRuntimeProfile(builtin)).sort()).toEqual([
      'binaryPath',
      'isSandbox',
      'model',
      'protocol',
    ])
    expect(read('modules/memory/composition.ts')).toContain(
      'distillRuntimeProfile(await nativeRuntimeResolver.resolve(request))',
    )
  })
})

describe('RFC-487 ③ doctor 的运行时探测经 system-operations 自有端口', () => {
  test('本机 doctor 调注入的探测；bootstrap 的 doctor 工厂与 standalone 软探测取 runtime-management 的默认二进制探测', () => {
    const doctor = read('modules/system-operations/infrastructure/local/doctorDiagnostics.ts')
    expect(doctor).toContain("return await input.runtimeBinary.probe('opencode', { opencodePath })")
    expect(doctor).toContain('readonly runtimeBinary: DoctorRuntimeBinaryProbe')
    const bootstrapDoctor = read('bootstrap/doctorDiagnostics.ts')
    expect(bootstrapDoctor).toContain('composeDefaultRuntimeBinaryProbe(),')
    const standalone = read('bootstrap/standalone.ts')
    expect(standalone).toContain('composeDefaultRuntimeBinaryProbe()')
    expect(standalone).not.toContain('getRuntimeDriver')
    expect(read('modules/runtime-management/composition/defaultRuntimeBinaryProbe.ts')).toContain(
      'createDefaultRuntimeBinaryProbe as composeDefaultRuntimeBinaryProbe',
    )
  })

  test('windows-platform 的两份路径过滤都登记 doctor 探测链的新位置（bootstrap 的绑定与默认二进制探测）', () => {
    const workflow = readFileSync(
      resolve(SRC, '..', '..', '..', '.github', 'workflows', 'windows-platform.yml'),
      'utf8',
    )
    const listed = [...workflow.matchAll(/^\s*- '([^']+)'\s*$/gm)].map((match) => match[1]!)
    // Positive control: the doctor family's own files are registered in both filters.
    expect(
      listed.filter(
        (entry) =>
          entry ===
          'packages/backend/src/modules/system-operations/infrastructure/local/doctorDiagnostics.ts',
      ),
    ).toHaveLength(2)
    for (const path of [
      'bootstrap/doctorDiagnostics.ts',
      'modules/runtime-management/infrastructure/local/defaultRuntimeBinaryProbe.ts',
      'modules/runtime-management/composition/defaultRuntimeBinaryProbe.ts',
    ]) {
      expect(existsSync(join(SRC, path))).toBe(true)
      expect(listed.filter((entry) => entry === `packages/backend/src/${path}`)).toHaveLength(2)
    }
  })
})

describe('RFC-487 ④ 挂载规则与原生内容记录的类型各在 owner 声明一次', () => {
  test('resolveBoundaryMounts 只在 source-control 的 domain 声明，经 public/queries 交出', () => {
    expect(declarationsOf('resolveBoundaryMounts', PRODUCTION)).toEqual([
      'modules/source-control/domain/taskAgentMounts.ts',
    ])
    expect(
      reExportsFrom('modules/source-control/public/queries.ts', '../domain/taskAgentMounts'),
    ).toEqual(['resolveBoundaryMounts'])
  })

  test('原生内容记录只在 resource-catalog 的 domain 声明；一族的 ResolvedSkill 扩展它、只加驱动侧的重读', () => {
    for (const name of ['SkillSource', 'NativeSkillContent', 'RuntimePlugin'])
      expect(declarationsOf(name, PRODUCTION)).toEqual([
        'modules/resource-catalog/domain/nativeAgentMaterialContents.ts',
      ])
    expect(
      reExportsFrom(
        'modules/resource-catalog/public/types.ts',
        '../domain/nativeAgentMaterialContents',
      ),
    ).toEqual(['NativeSkillContent', 'RuntimePlugin', 'SkillSource'])
    expect(
      reExportsFrom('services/runtime/types.ts', '@/modules/resource-catalog/public/types'),
    ).toEqual(['SkillSource'])
    expect(declarationsOf('ResolvedSkill', PRODUCTION)).toEqual(['services/runtime/types.ts'])
    const family = parse('services/runtime/types.ts', read('services/runtime/types.ts'))
    const resolved = family.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === 'ResolvedSkill',
    )
    expect(resolved?.heritageClauses?.map((clause) => clause.getText(family))).toEqual([
      'extends NativeSkillContent',
    ])
    expect(resolved?.members.map((member) => member.name?.getText(family))).toEqual([
      'readContentVersion',
    ])
    expect(
      reExportsFrom(
        'services/execution/agentInjection.ts',
        '@/modules/resource-catalog/public/types',
      ),
    ).toEqual(['RuntimePlugin'])
  })
})

describeEachProvider('RFC-487 ⑤ 经绑定的解析与探测', (harness) => {
  test('memory 经 bootstrap 形状的绑定解析四种输入，与此前 memory 自己的解析一致', async () => {
    const registry = composeRuntimeRegistryOperations(harness.db)
    await registry.createRuntime({
      name: 'rfc487-distill',
      protocol: 'claude-code',
      model: 'rfc487-model',
    })
    const row = await registry.getRuntime('rfc487-distill')
    if (row === null) throw new Error('runtime row missing')
    const runtimes = runtimeManagementDistillRuntimes(harness.db)
    const pick = (value: {
      readonly protocol: string
      readonly binaryPath: string | null
      readonly model: string | null
      readonly isSandbox: boolean
      readonly observationIdentity?: unknown
    }) => ({
      protocol: value.protocol,
      binaryPath: value.binaryPath,
      model: value.model,
      isSandbox: value.isSandbox,
      observationIdentity: value.observationIdentity,
    })

    // 已注册的名字：取该行的协议、二进制、模型与观测身份（id、probeFence、name）。
    expect(pick(await runtimes.resolve({ runtimeName: 'rfc487-distill' }))).toEqual({
      protocol: 'claude-code',
      binaryPath: null,
      model: 'rfc487-model',
      isSandbox: false,
      observationIdentity: {
        registrationId: row.id,
        configurationRevision: row.probeFence,
        acceptedName: 'rfc487-distill',
      },
    })
    // 内建协议名、没有登记行：回到该协议，参数为空，没有观测身份。
    expect(pick(await runtimes.resolve({ runtimeName: 'claude-code' }))).toEqual({
      protocol: 'claude-code',
      binaryPath: null,
      model: null,
      isSandbox: false,
      observationIdentity: undefined,
    })
    // 未知名字：回落 opencode。
    expect(pick(await runtimes.resolve({ runtimeName: 'rfc487-no-such-runtime' }))).toEqual({
      protocol: 'opencode',
      binaryPath: null,
      model: null,
      isSandbox: false,
      observationIdentity: undefined,
    })
    // 已弃用的模型（没有运行时名字）：opencode 加该模型。
    expect(pick(await runtimes.resolve({ deprecatedModel: 'rfc487-legacy-model' }))).toEqual({
      protocol: 'opencode',
      binaryPath: null,
      model: 'rfc487-legacy-model',
      isSandbox: false,
      observationIdentity: undefined,
    })
  })

  test('doctor 的 probeRuntime 把配置的 opencode 路径原样交给注入的探测、原样返回结果', async () => {
    const calls: unknown[] = []
    const result = { binary: '/opt/rfc487/opencode', version: '1.2.3', ran: true }
    const runtimeBinary: DoctorRuntimeBinaryProbe = {
      async probe(protocol, config) {
        calls.push([protocol, config])
        return result
      },
    }
    const diagnostics = createLocalDoctorDiagnosticsFactory(
      logicalSchemaContract,
      composeSystemOperationsTaskPorts(),
      runtimeBinary,
    ).create({})
    expect(await diagnostics.probeRuntime('/opt/rfc487/opencode')).toBe(result)
    expect(calls).toEqual([['opencode', { opencodePath: '/opt/rfc487/opencode' }]])
  })
})
