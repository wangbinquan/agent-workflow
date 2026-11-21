// RFC-525 — 资源目录的适配器回落改为必填注入（RFC-294 S12 第六步）。
//
// 锁四件事（design §3 的清单即退出门；回落本身由 RFC-521 门的登记锁住）：
// ① 选项的形状（语法树）：技能内容绑定的两项、技能目录 / 可用性 / 版本推进 / 资源包 provider / 维护场景 / 插件 / MCP 探测与 daemon 资源目录
//    装配的入参逐个钉住；只为回落存在的选项不在。
// ② bootstrap 不取 resource-catalog 的 infrastructure；`skillContentRoot` 在生产代码里不再出现（语料下限 3,000）。
// ③ 装配处的显式构造逐处钉住：资源包命令的三个本机实现与参数、维护 worker 的选择与冲突检查、单机 MCP 诊断的进程内执行器。
// ④ 测试助手与此前回落相同：给了原样交出；缺安装器又缺插件属主时照旧拒绝；维护场景两项都给仍报冲突。
// 均带负对照。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  composeStandaloneResourcePackageApplyMaintenance,
  composeStandaloneSkillVersionCommitParticipantFactory,
  standaloneResourcePackageProviderSelections,
} from './helpers/resourceCatalog'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, source: string) =>
  ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
      return /\.tsx?$/.test(entry.name) ? [path] : []
    })
}
const PRODUCTION = walk(SRC)
const TEXTS = new Map<string, string>()
const text = (path: string) => {
  let content = TEXTS.get(path)
  if (content === undefined) TEXTS.set(path, (content = readFileSync(path, 'utf8')))
  return content
}
const srcPath = (path: string) => slash(relative(SRC, path)).replace(/\.tsx?$/, '')
/** The corpus test reads every production file; the first read is cold. */
const CORPUS_TIMEOUT = 30_000

const at = (...parts: string[]) => join(SRC, ...parts)
const RC = (...parts: string[]) => at('modules', 'resource-catalog', 'composition', ...parts)
const BINDING = RC('skillContentBinding.ts')
const SKILLS = RC('skillOperations.ts')
const CLASSIC = RC('classicCatalogs.ts')
const WORKFLOWS = RC('workflowOperations.ts')
const COMMIT = RC('skillVersionCommit.ts')
const PROVIDER = RC('resourcePackageProvider.ts')
const PACKAGES = RC('postgresqlResourcePackageCatalog.ts')
const MAINTENANCE = RC('resourcePackageMaintenance.ts')
const PLUGINS = RC('pluginOperations.ts')
const PROBES = RC('mcpProbeOperations.ts')
const DIAGNOSTICS = RC('mcpDiagnostics.ts')
const DAEMON_RC = at('bootstrap', 'daemonModules', 'resourceCatalog.ts')
const FUSION = at('bootstrap', 'daemonModules', 'fusion.ts')
const COMMANDS = at('bootstrap', 'commandBootstraps.ts')
const WORKER = at('bootstrap', 'maintenanceWorkerGraph.ts')

/** Property names and optionality of an interface, or of the first parameter's type literal of a function. */
function members(path: string, source: string, name: string): Map<string, boolean> {
  const file = parse(path, source)
  const result = new Map<string, boolean>()
  const take = (list: ts.NodeArray<ts.TypeElement>) => {
    for (const member of list)
      if (ts.isPropertySignature(member))
        result.set(member.name.getText(file), member.questionToken !== undefined)
  }
  const visit = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) take(node.members)
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body !== undefined) {
      const type = node.parameters[0]?.type
      const literals: ts.TypeLiteralNode[] = []
      const collect = (part: ts.Node) => {
        if (ts.isTypeLiteralNode(part)) literals.push(part)
        else if (ts.isIntersectionTypeNode(part)) part.types.forEach(collect)
      }
      if (type !== undefined) collect(type)
      for (const literal of literals) take(literal.members)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}

/** Every declaration of a function `name` (overload signatures included): its parameters as `name?=default`. */
function signatures(path: string, source: string, name: string): string[][] {
  const file = parse(path, source)
  const result: string[][] = []
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      result.push(
        node.parameters.map(
          (parameter) =>
            parameter.name.getText(file) +
            (parameter.questionToken === undefined ? '' : '?') +
            (parameter.initializer === undefined ? '' : '=default'),
        ),
      )
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}

/** The argument texts (whitespace and trailing commas removed) of every call of `name` in the file. */
function callArguments(path: string, source: string, name: string): string[][] {
  const file = parse(path, source)
  const calls: string[][] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === name)
      calls.push(
        node.arguments.map((argument) =>
          argument
            .getText(file)
            .replace(/\s+/g, '')
            .replace(/,(?=[)\]}])/g, ''),
        ),
      )
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}

/** Module specifiers a file imports that reach resource-catalog's infrastructure. */
function infrastructureImports(path: string, source: string): string[] {
  return parse(path, source)
    .statements.flatMap((statement) =>
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : [],
    )
    .filter((specifier) => /resource-catalog\/infrastructure(\/|$)/.test(specifier))
}

describe('RFC-525 ① 选项的形状', () => {
  test('技能内容：绑定的两项必填；选择助手只收绑定；技能目录、可用性与版本推进的选项必填', () => {
    const binding = members(BINDING, text(BINDING), 'SkillContentBinding')
    expect([binding.get('packageContent'), binding.get('treeContent')]).toEqual([false, false])
    expect(signatures(BINDING, text(BINDING), 'selectSkillContentDependencies')).toEqual([
      ['binding'],
    ])
    const skills = members(SKILLS, text(SKILLS), 'SkillCatalogCompositionDependencies')
    expect(
      [
        'content',
        'versionReader',
        'lifecycleContent',
        'deletionContent',
        'versionContent',
        'creationContent',
      ].map((name) => [name, skills.get(name)]),
    ).toEqual([
      ['content', false],
      ['versionReader', false],
      ['lifecycleContent', false],
      ['deletionContent', false],
      ['versionContent', false],
      ['creationContent', false],
    ])
    expect(
      members(CLASSIC, text(CLASSIC), 'ClassicCatalogCompositionDependencies').get(
        'versionPresence',
      ),
    ).toBe(false)
    expect([...members(WORKFLOWS, text(WORKFLOWS), 'composeSkillContentAvailability')]).toEqual([
      ['versionPresence', false],
    ])
    expect(signatures(COMMIT, text(COMMIT), 'composeSkillVersionCommitParticipantFactory')).toEqual(
      [['selection']],
    )
    expect([
      ...members(COMMIT, text(COMMIT), 'composeSkillVersionCommitParticipantFactory'),
    ]).toEqual([['skillContent', false]])
  })

  test('资源包、插件与 MCP 探测：选择必填，只为回落存在的选项不在', () => {
    expect([...members(PROVIDER, text(PROVIDER), 'composeResourcePackageProvider')]).toEqual([
      ['db', false],
      ['appHome', false],
      ['skillPackageContent', false],
    ])
    const provider = members(
      PACKAGES,
      text(PACKAGES),
      'PostgresqlResourcePackageProviderDependencies',
    )
    expect(
      [
        'skillPackageContent',
        'skillArtifacts',
        'pluginArtifacts',
        'pluginInstaller',
        'pluginsDir',
      ].map((name) => [name, provider.get(name)]),
    ).toEqual([
      ['skillPackageContent', false],
      ['skillArtifacts', false],
      ['pluginArtifacts', false],
      ['pluginInstaller', undefined],
      ['pluginsDir', undefined],
    ])
    const maintenance = members(
      MAINTENANCE,
      text(MAINTENANCE),
      'composeResourcePackageApplyMaintenance',
    )
    expect(
      ['artifacts', 'appHome', 'pluginsDir', 'recoveryEffectsFactory'].map((name) => [
        name,
        maintenance.get(name),
      ]),
    ).toEqual([
      ['artifacts', false],
      ['appHome', undefined],
      ['pluginsDir', undefined],
      ['recoveryEffectsFactory', undefined],
    ])
    expect(
      members(PLUGINS, text(PLUGINS), 'PluginCatalogAdapterCompositionDependencies').get(
        'installer',
      ),
    ).toBe(false)
    expect(members(PROBES, text(PROBES), 'composeMcpProbeOperations').get('probeRunner')).toBe(
      false,
    )
  })

  test('bootstrap：daemon 资源目录装配的内容绑定与安装器必填，默认根目录不在；融合装配的内容绑定必填', () => {
    const daemon = members(DAEMON_RC, text(DAEMON_RC), 'composeDaemonResourceCatalogModules')
    expect([
      daemon.get('skillContent'),
      daemon.get('pluginInstaller'),
      daemon.has('skillContentRoot'),
    ]).toEqual([false, false, false])
    expect(members(FUSION, text(FUSION), 'composeDaemonFusionModules').get('skillContent')).toBe(
      false,
    )
  })

  test('负对照：可选成员与缺省参数都认得出', () => {
    const probe = join(SRC, 'probe.ts')
    const source = [
      'export interface P { readonly a?: string; readonly b: string }',
      'export function f(input: { readonly c: number } = { c: 1 }) { return input }',
    ].join('\n')
    expect([...members(probe, source, 'P')]).toEqual([
      ['a', true],
      ['b', false],
    ])
    expect(signatures(probe, source, 'f')).toEqual([['input=default']])
  })
})

describe('RFC-525 ② bootstrap 的依赖与删去的选项', () => {
  test(
    'bootstrap 不取 resource-catalog 的 infrastructure；`skillContentRoot` 在生产代码里不再出现（语料下限 3,000）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      expect(
        PRODUCTION.filter((path) => text(path).includes('skillContentRoot')).map(srcPath),
      ).toEqual([])
      const bootstrap = PRODUCTION.filter((path) => srcPath(path).startsWith('bootstrap/'))
      expect(bootstrap.length).toBeGreaterThan(20)
      expect(
        bootstrap.flatMap((path) =>
          infrastructureImports(path, text(path)).map((spec) => `${srcPath(path)}: ${spec}`),
        ),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：resource-catalog infrastructure 的 import 认得出', () => {
    const probe = join(SRC, 'bootstrap', 'probe.ts')
    expect(
      infrastructureImports(
        probe,
        [
          "import { a } from '@/modules/resource-catalog/infrastructure/local/fileSkillContentReader'",
          "import { b } from '@/modules/resource-catalog/composition/skillContentBinding'",
        ].join('\n'),
      ),
    ).toEqual(['@/modules/resource-catalog/infrastructure/local/fileSkillContentReader'])
  })
})

describe('RFC-525 ③ 装配处的显式构造', () => {
  test('资源包命令：本机的包内容、技能与插件工件属主，参数与此前回落相同', () => {
    const runtime = callArguments(COMMANDS, text(COMMANDS), 'composeResourcePackageRuntime')
    expect(runtime).toHaveLength(1)
    for (const expected of [
      'skillPackageContent:createFileSkillPackageContentReader(Paths.root)',
      'skillArtifacts:createFileResourcePackageSkillArtifactOwner({db:provider.db,appHome:Paths.root})',
      "pluginArtifacts:createFileResourcePackagePluginArtifactOwner({pluginsDir:join(Paths.root,'plugins'),installer:createResourcePackagePluginInstaller()})",
    ])
      expect(runtime[0]![0]).toContain(expected)
    expect(runtime[0]![0]).not.toContain('pluginInstaller:')
  })

  test('维护 worker：两处都经同一个选择；冲突检查照旧，本机恢复带选定的恢复内容（RFC-528：本机恢复在单机 profile 的 worker 部分）', () => {
    const maintenance = callArguments(
      WORKER,
      text(WORKER),
      'composeResourcePackageApplyMaintenance',
    )
    expect(maintenance).toHaveLength(2)
    for (const [argument] of maintenance)
      expect(argument).toContain('artifacts:effects.resourcePackageRecovery')
    expect(callArguments(WORKER, text(WORKER), 'selectWorkerEffects')).toEqual([
      ['{selected:workerEffects,db,appHome}'],
      ['{selected:workerEffects,db,appHome,log:resourcePackageLog}'],
    ])
    expect(callArguments(WORKER, text(WORKER), 'requireExclusiveRecoverySelection')).toEqual([
      [
        '{artifacts:selected?.resourcePackageRecovery,recoveryEffectsFactory:selected?.resourcePackageRecoveryContent}',
      ],
    ])
    expect(text(WORKER).replace(/\s+/g, '')).toContain(
      'resourcePackageRecovery:selected?.resourcePackageRecovery??standalone.resourcePackageRecovery(scope,selected?.resourcePackageRecoveryContent)',
    )
    expect(
      callArguments(WORKER, text(WORKER), 'composeLocalResourcePackageArtifactRecovery'),
    ).toEqual([])
    const standalone = at('bootstrap', 'standaloneMaintenanceWorker.ts')
    expect(
      callArguments(standalone, text(standalone), 'composeLocalResourcePackageArtifactRecovery'),
    ).toEqual([["{db,appHome,pluginsDir:join(appHome,'plugins'),recoveryEffectsFactory,log}"]])
  })

  test('单机 MCP 诊断显式选进程内执行器', () => {
    expect(callArguments(DIAGNOSTICS, text(DIAGNOSTICS), 'createInProcessMcpProbeRunner')).toEqual([
      [],
    ])
    expect(text(DIAGNOSTICS)).not.toContain('probeRunner: undefined')
  })
})

describe('RFC-525 ④ 测试助手与此前回落相同', () => {
  const db = {} as PersistenceDb
  test('资源包 provider 的选择：给了的原样交出；插件属主与安装器都没给时拒绝', () => {
    const given = {
      pluginArtifacts: {} as never,
      skillArtifacts: {} as never,
      skillPackageContent: {} as never,
    }
    const passed = standaloneResourcePackageProviderSelections({ db, appHome: '/unused', ...given })
    expect(passed.pluginArtifacts).toBe(given.pluginArtifacts)
    expect(passed.skillArtifacts).toBe(given.skillArtifacts)
    expect(passed.skillPackageContent).toBe(given.skillPackageContent)
    expect(() =>
      standaloneResourcePackageProviderSelections({
        db,
        appHome: '/unused',
        skillArtifacts: given.skillArtifacts,
        skillPackageContent: given.skillPackageContent,
      }),
    ).toThrow(/^resource-package-test: give pluginArtifacts or pluginInstaller$/)
  })

  test('维护场景：同时给工件恢复与恢复内容效果照旧报冲突；版本推进的缺省工厂有 bind', () => {
    expect(() =>
      composeStandaloneResourcePackageApplyMaintenance({
        db,
        appHome: '/unused',
        pluginsDir: '/unused/plugins',
        artifacts: {} as never,
        recoveryEffectsFactory: {} as never,
      }),
    ).toThrow(/^resource-package-recovery-selections-conflict$/)
    expect(typeof composeStandaloneSkillVersionCommitParticipantFactory().bind).toBe('function')
  })
})
