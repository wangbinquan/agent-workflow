// RFC-523 — 意图、代码历史与记忆的适配器回落改为必填注入（RFC-294 S12 第四步）。
//
// 锁三件事（design §3 的清单即退出门；回落本身由 RFC-521 门的登记锁住）：
// ① 选项的形状（语法树）：intent apply 的依赖只含 db / resources / artifacts / id / now 且前两项必填；工件生命周期的 content 与
//    legacySkillArtifacts、恢复场景的 artifacts、维护命令的 scratch、记忆的 injectionQueries 必填；代码历史的第三个参数没有缺省值。
// ② 全部生产文件（下限 3,000；先按名字文本筛再解析）里没有 `applyIntentChangeset`、`ApplyIntentDeps` 与 `createUnboundCodeHistoryReader` 的
//    声明；bootstrap 不取 intent 的 infrastructure。
// ③ daemon 与维护 worker 的显式构造用的是此前回落的同一组工厂（实参钉住），两个单机选择同样；带负对照。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

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
const APPLY = at('modules', 'intent', 'composition', 'apply.ts')
const RECOVERY = at('modules', 'intent', 'composition', 'applyMaintenance.ts')
const MAINTENANCE = at('modules', 'intent', 'composition', 'maintenance.ts')
const MEMORY = at('modules', 'memory', 'composition.ts')
const HISTORY = at('modules', 'code-capability', 'composition', 'historyQueries.ts')
const DAEMON_INTENT = at('bootstrap', 'daemonModules', 'intent.ts')
const WORKER = at('bootstrap', 'maintenanceWorkerGraph.ts')
// RFC-528: the standalone worker's intent selections moved into the standalone profile's worker part.
const STANDALONE_WORKER = at('bootstrap', 'standaloneMaintenanceWorker.ts')

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
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
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

/** Whether the file declares or re-exports `name`. */
function declaresOrExports(path: string, source: string, name: string): boolean {
  const file = parse(path, source)
  let found = false
  const visit = (node: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node)) &&
      node.name?.text === name
    )
      found = true
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
      found = true
    if (ts.isExportSpecifier(node) && node.name.text === name) found = true
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** Module specifiers a file imports that reach intent's infrastructure. */
function intentInfrastructureImports(path: string, source: string): string[] {
  return parse(path, source)
    .statements.flatMap((statement) =>
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : [],
    )
    .filter((specifier) => /(^@\/modules\/intent|\/intent)\/infrastructure(\/|$)/.test(specifier))
}

/** The argument texts (whitespace and trailing commas removed) of every call of `name` in the file. */
function callArguments(path: string, source: string, name: string): string[][] {
  const file = parse(path, source)
  const calls: string[][] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
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

describe('RFC-523 ① 选项的形状', () => {
  test('依赖收窄、必填项必填、删去的选项不在、代码历史的第三个参数没有缺省值', () => {
    expect([...members(APPLY, text(APPLY), 'IntentApplyCompositionDependencies')]).toEqual([
      ['db', false],
      ['resources', false],
      ['artifacts', false],
      ['id', true],
      ['now', true],
    ])
    const lifecycle = members(APPLY, text(APPLY), 'composeIntentApplyArtifactLifecycle')
    // RFC-595: the content-location query is a required input too (bootstrap hands it over).
    expect([
      lifecycle.get('content'),
      lifecycle.get('legacySkillArtifacts'),
      lifecycle.get('skillContentLocations'),
    ]).toEqual([false, false, false])
    const recovery = members(RECOVERY, text(RECOVERY), 'composeIntentApplyRecoveryScene')
    expect([...recovery.keys()].sort()).toEqual(['artifacts', 'db', 'log', 'now'])
    expect(recovery.get('artifacts')).toBe(false)
    const maintenance = members(
      MAINTENANCE,
      text(MAINTENANCE),
      'ProviderIntentMaintenanceCompositionInput',
    )
    expect([...maintenance]).toEqual([
      ['scratch', false],
      ['log', true],
    ])
    expect(
      members(MEMORY, text(MEMORY), 'ComposeMemoryOperationsOptions').get('injectionQueries'),
    ).toBe(false)
    const file = parse(HISTORY, text(HISTORY))
    let third: ts.ParameterDeclaration | undefined
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'composeCodeHistoryQueries')
        third = node.parameters[2]
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect([third?.name.getText(file), third?.initializer, third?.questionToken]).toEqual([
      'history',
      undefined,
      undefined,
    ])
  })

  test('负对照：可选属性与类型字面量里的成员都认得出', () => {
    const probe = join(SRC, 'probe.ts')
    const source = [
      'export interface P { readonly a?: string; readonly b: string }',
      'export function f(input: { readonly c?: number } & { readonly d: number }) { return input }',
    ].join('\n')
    expect([...members(probe, source, 'P')]).toEqual([
      ['a', true],
      ['b', false],
    ])
    expect([...members(probe, source, 'f')]).toEqual([
      ['c', true],
      ['d', false],
    ])
  })
})

describe('RFC-523 ② 便捷入口与 bootstrap 的依赖', () => {
  test(
    '生产代码里没有三个只给用例用的名字；bootstrap 不取 intent 的 infrastructure（语料下限 3,000）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      for (const name of [
        'applyIntentChangeset',
        'ApplyIntentDeps',
        'createUnboundCodeHistoryReader',
      ])
        expect([
          name,
          PRODUCTION.filter(
            (path) => text(path).includes(name) && declaresOrExports(path, text(path), name),
          ).map(srcPath),
        ]).toEqual([name, []])
      const bootstrap = PRODUCTION.filter((path) => srcPath(path).startsWith('bootstrap/'))
      expect(bootstrap.length).toBeGreaterThan(20)
      expect(
        bootstrap.flatMap((path) =>
          intentInfrastructureImports(path, text(path)).map((spec) => `${srcPath(path)}: ${spec}`),
        ),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：声明与 intent infrastructure 的 import 都认得出', () => {
    const probe = join(SRC, 'bootstrap', 'probe.ts')
    expect(
      declaresOrExports(probe, 'export function applyIntentChangeset() {}', 'applyIntentChangeset'),
    ).toBe(true)
    expect(declaresOrExports(probe, 'export interface ApplyIntentDeps {}', 'ApplyIntentDeps')).toBe(
      true,
    )
    expect(
      intentInfrastructureImports(
        probe,
        [
          "import { x } from '@/modules/intent/infrastructure/local/fileIntentScratchStore'",
          "import { y } from '@/modules/intent/composition/maintenance'",
        ].join('\n'),
      ),
    ).toEqual(['@/modules/intent/infrastructure/local/fileIntentScratchStore'])
  })
})

describe('RFC-523 ③ 显式构造用的是此前回落的同一组工厂', () => {
  test('daemon：工件生命周期带旧版兼容绑定，资源会话绑定用部署选择的两个属主与新建的 MCP 事务生命周期', () => {
    const source = text(DAEMON_INTENT)
    expect(callArguments(DAEMON_INTENT, source, 'composeIntentApplyArtifactLifecycle')).toEqual([
      [
        '{db,appHome,content:input.adapters.intentArtifacts.artifactContent,legacySkillArtifacts:composeLegacyIntentSkillArtifactCompat(),skillContentLocations:createSkillContentLocationQuery(db)}',
      ],
    ])
    expect(callArguments(DAEMON_INTENT, source, 'composeIntentApplyResourceBinding')).toEqual([
      [
        '{db,mcpLifecycle:createMcpTransactionLifecycle(),pluginArtifacts:input.adapters.intentArtifacts.pluginArtifacts,skillArtifacts:input.adapters.intentArtifacts.skillArtifacts,aclIdentities:resources.resourceCatalog.persistence.identities}',
      ],
    ])
  })

  test('维护 worker：托管效果在时取托管的，否则取 intent 的单机选择（RFC-528：单机一支在单机 profile 的 worker 部分）', () => {
    const source = text(WORKER)
    const maintenance = callArguments(WORKER, source, 'composeIntentMaintenanceCommandsForDatabase')
    expect(maintenance).toHaveLength(1)
    expect(maintenance[0]![0]).toContain('scratch:effects.intentScratch')
    const lifecycle = callArguments(WORKER, source, 'composeIntentApplyArtifactLifecycle')
    expect(lifecycle).toEqual([
      [
        '{db:client,appHome,pluginsDir:intentPluginsDir,content:effects.intentArtifactContent,legacySkillArtifacts:composeLegacyIntentSkillArtifactCompat(),skillContentLocations:createSkillContentLocationQuery(client)}',
      ],
    ])
    const compact = source.replace(/\s+/g, '')
    expect(compact).toContain(
      'intentScratch:selected?.intentScratch??standalone.intentScratch(scope)',
    )
    expect(compact).toContain(
      'intentArtifactContent:selected?.intentArtifactContent??standalone.intentArtifactContent(scope)',
    )
    const standalone = text(STANDALONE_WORKER)
    expect(callArguments(STANDALONE_WORKER, standalone, 'composeLocalIntentScratch')).toEqual([
      ['{appHome}'],
    ])
    expect(
      callArguments(STANDALONE_WORKER, standalone, 'composeLocalIntentArtifactContent'),
    ).toEqual([
      [
        "{appHome,pluginsDir:join(appHome,'plugins'),skillArtifacts:composePostgresqlSkillArtifactCompensation()}",
      ],
    ])
  })

  test('两个单机选择：同一个工厂、同一组参数', () => {
    expect(callArguments(APPLY, text(APPLY), 'createFileIntentArtifactContent')).toEqual([
      ['{appHome:input.appHome,pluginsDir:input.pluginsDir,skillArtifacts:input.skillArtifacts}'],
    ])
    expect(callArguments(MAINTENANCE, text(MAINTENANCE), 'createFileIntentScratchStore')).toEqual([
      ['{appHome:input.appHome,directoryName:input.directoryName??INTENT_SCRATCH_DIRNAME}'],
    ])
  })
})
