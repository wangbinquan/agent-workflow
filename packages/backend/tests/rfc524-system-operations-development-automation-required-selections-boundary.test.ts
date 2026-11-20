// RFC-524 — 系统运维与开发自动化的适配器回落改为必填注入（RFC-294 S12 第五步）。
//
// 锁四件事（design §3 的清单即退出门；回落本身由 RFC-521 门的登记锁住）：
// ① 选项的形状（语法树）：各入口的成员与可选标记逐个钉住；数据库准备是按 `kind` 区分的两支；开发交付只剩一个签名。
// ② 全部生产文件（下限 3,000；先按名字文本筛再解析）里不再声明清单里删去的名字；打开前恢复（入口与用例）只在测试助手里，删除的
//    旧版证据桥不在，integration 不再转出只有它用的类型；bootstrap 不取两个模块的 infrastructure，也不再把部署选择的 `null` 转回
//    `undefined`。
// ③ 装配处的显式构造逐处钉住（实参去空白）：此前回落造的同一组工厂与参数；数据库准备的两支各调用此前的准备。
// ④ 测试助手与此前回落相同：只在没给时构造、给了原样交出；平台工作项的证据库首次读成员前不建目录，`then` 不触发构建。
// 均带负对照。
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { assertEvidenceStagingFactory } from '@/modules/development-automation/public/participants'
import type { EvidenceArtifactPort } from '@/modules/development-automation/application/ports/evidenceArtifacts'
import type { EvidenceDocumentCommands } from '@/modules/development-automation/application/evidenceDocumentCommands'
import type { AdmissionLookup } from '@/modules/development-automation/application/ports/admissionLookup'
import type { EvidenceStagingFactory } from '@/modules/development-automation/application/ports/evidenceStaging'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  composeStandaloneDevelopmentAutomationSelections,
  composeStandalonePlatformWorkItemEvidence,
} from './helpers/developmentAutomation'

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
const SO = (...parts: string[]) => at('modules', 'system-operations', ...parts)
const DA = (...parts: string[]) => at('modules', 'development-automation', ...parts)
const SO_ROOT = SO('composition.ts')
const DAEMON_DATABASE = SO('composition', 'daemonDatabase.ts')
const MIGRATION = SO('composition', 'databaseMigration.ts')
const MANUAL = SO('composition', 'manualDatabaseMigration.ts')
const SEED = SO('composition', 'installationSeedCompletion.ts')
const DA_ROOT = DA('composition.ts')
const DELIVERY = DA('composition', 'developmentDelivery.ts')
const WORK_ITEMS = DA('composition', 'digitalEmployeePlatformWorkItems.ts')
const UPLOADS = DA('composition', 'missionInputUploads.ts')
const START = at('bootstrap', 'daemonStart.ts')
const RELOAD = at('bootstrap', 'developmentReload.ts')
const SESSION = at('bootstrap', 'daemonSession.ts')
const APPLICATION = at('bootstrap', 'daemonApplication.ts')
const HTTP = at('bootstrap', 'daemonHttpComposition.ts')
const COMMANDS = at('bootstrap', 'commandBootstraps.ts')
const MIGRATE = at('bootstrap', 'migrate.ts')
const DAEMON_DA = at('bootstrap', 'daemonModules', 'developmentAutomation.ts')

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

/** For a union type alias of type literals: each branch's members and optionality. */
function unionBranches(path: string, source: string, name: string): [string, boolean][][] {
  const file = parse(path, source)
  const result: [string, boolean][][] = []
  const visit = (node: ts.Node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name && ts.isUnionTypeNode(node.type))
      for (const branch of node.type.types)
        if (ts.isTypeLiteralNode(branch))
          result.push(
            branch.members
              .filter(ts.isPropertySignature)
              .map((member) => [member.name.getText(file), member.questionToken !== undefined]),
          )
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

/** Module specifiers a file imports that reach system-operations' or development-automation's infrastructure. */
function infrastructureImports(path: string, source: string): string[] {
  return parse(path, source)
    .statements.flatMap((statement) =>
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : [],
    )
    .filter((specifier) =>
      /(system-operations|development-automation)\/infrastructure(\/|$)/.test(specifier),
    )
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

/** The left operand of the `??` whose right operand is the only call of `name`, or null. */
function choiceBefore(path: string, source: string, name: string): string | null {
  const file = parse(path, source)
  const found: (string | null)[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === name) {
      const parent = node.parent
      found.push(
        ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
          parent.right === node
          ? parent.left.getText(file).replace(/\s+/g, '')
          : null,
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found.length === 1 ? found[0]! : null
}

describe('RFC-524 ① 选项的形状', () => {
  test('system-operations：本机系统运维、迁移模块、手动迁移、种子标记与 daemon 的数据库准备', () => {
    expect([...members(SO_ROOT, text(SO_ROOT), 'composeLocalSystemOperations')]).toEqual([
      ['repositoryBackupPreparationFactory', false],
      ['contract', false],
      ['repositoryBackupPreparation', true],
      ['databaseConfig', false],
      ['providerRuntime', false],
    ])
    const migration = members(MIGRATION, text(MIGRATION), 'composeDatabaseMigrationModule')
    expect([migration.get('configuration'), migration.has('configPath')]).toEqual([false, false])
    expect(unionBranches(MANUAL, text(MANUAL), 'ManualDatabaseMigrationOptions')).toEqual([
      [
        ['kind', false],
        ['configuration', false],
        ['installation', false],
      ],
      [
        ['kind', false],
        ['configuration', false],
      ],
    ])
    expect(signatures(MANUAL, text(MANUAL), 'prepareManualDatabaseMigration')).toEqual([
      ['contract', 'options'],
    ])
    expect(signatures(SEED, text(SEED), 'composeLocalInstallationSeedCompletion')).toEqual([[]])
    expect([
      ...members(DAEMON_DATABASE, text(DAEMON_DATABASE), 'SelectedDaemonDatabasePreparation'),
    ]).toEqual([
      ['kind', false],
      ['configuration', false],
      ['installation', false],
      ['file', false],
    ])
    expect([
      ...members(DAEMON_DATABASE, text(DAEMON_DATABASE), 'FileDaemonDatabasePreparation'),
    ]).toEqual([
      ['kind', false],
      ['configuration', false],
      ['file', false],
    ])
  })

  test('bootstrap：daemon 应用与 HTTP 装配的运行期查询必填，信息文件路径不再是入参', () => {
    for (const [path, name] of [
      [APPLICATION, 'DaemonApplicationInput'],
      [HTTP, 'ProviderAppOwnerInput'],
    ] as const) {
      const input = members(path, text(path), name)
      expect([name, input.get('daemonRuntime'), input.has('daemonInfoPath')]).toEqual([
        name,
        false,
        false,
      ])
    }
  })

  test('development-automation：证据库、准入查询、写入器与暂存必填；开发交付只剩一个签名', () => {
    const automation = members(DA_ROOT, text(DA_ROOT), 'DevelopmentAutomationCompositionOptions')
    expect(
      [
        'evidenceArtifacts',
        'admissionLookup',
        'requirementStaging',
        'evidenceDocumentCommands',
      ].map((name) => [name, automation.get(name)]),
    ).toEqual([
      ['evidenceArtifacts', false],
      ['admissionLookup', false],
      ['requirementStaging', false],
      ['evidenceDocumentCommands', false],
    ])
    expect(
      members(
        WORK_ITEMS,
        text(WORK_ITEMS),
        'DevelopmentEmployeePlatformWorkItemsCompositionInput',
      ).get('evidenceArtifacts'),
    ).toBe(false)
    expect([...members(UPLOADS, text(UPLOADS), 'composeMissionInputUploadOperations')]).toEqual([
      ['db', false],
      ['artifacts', false],
    ])
    expect(signatures(DELIVERY, text(DELIVERY), 'composeDevelopmentPipelineDeps')).toEqual([
      ['runner', 'staging'],
    ])
  })

  test('负对照：可选成员、联合的各支、重载与缺省参数都认得出', () => {
    const probe = join(SRC, 'probe.ts')
    const source = [
      'export interface P { readonly a?: string; readonly b: string }',
      "export type U = { readonly kind: 'x'; readonly c?: number } | { readonly kind: 'y' }",
      'export function f(input: string): void',
      'export function f(input: string, more = 1): void {}',
    ].join('\n')
    expect([...members(probe, source, 'P')]).toEqual([
      ['a', true],
      ['b', false],
    ])
    expect(unionBranches(probe, source, 'U')).toEqual([
      [
        ['kind', false],
        ['c', true],
      ],
      [['kind', false]],
    ])
    expect(signatures(probe, source, 'f')).toEqual([['input'], ['input', 'more=default']])
  })
})

describe('RFC-524 ② 删去的入口与 bootstrap 的依赖', () => {
  test(
    '生产代码里不再声明删去的名字；打开前恢复与旧版证据桥的文件不在，integration 不转出只有它用的类型；bootstrap 不取两个模块的 infrastructure（语料下限 3,000）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      for (const name of [
        'selectDaemonHostLifecycle',
        'selectDaemonRuntimeQueries',
        'composeInstallationSeedCompletion',
        'DaemonDatabasePreOpenRecoveryPort',
        'composeRequirementMaterializerContent',
        'lazyEvidenceBlobs',
        'composeLegacyDevelopmentPipelineEvidence',
        'LegacyPipelineEvidencePort',
        'prepareDatabasePreOpenRecovery',
        'PreparedDatabasePreOpenRecovery',
      ])
        expect([
          name,
          PRODUCTION.filter(
            (path) => text(path).includes(name) && declaresOrExports(path, text(path), name),
          ).map(srcPath),
        ]).toEqual([name, []])
      for (const gone of [
        SO('application', 'prepareDatabasePreOpenRecovery.ts'),
        DA('infrastructure', 'local', 'legacyPipelineEvidence.ts'),
      ])
        expect([srcPath(gone), existsSync(gone)]).toEqual([srcPath(gone), false])
      const integration = at('modules', 'integration', 'public', 'participants.ts')
      expect(declaresOrExports(integration, text(integration), 'PipelineEvidenceExecution')).toBe(
        false,
      )
      const bootstrap = PRODUCTION.filter((path) => srcPath(path).startsWith('bootstrap/'))
      expect(bootstrap.length).toBeGreaterThan(20)
      expect(
        bootstrap.flatMap((path) =>
          infrastructureImports(path, text(path)).map((spec) => `${srcPath(path)}: ${spec}`),
        ),
      ).toEqual([])
      expect(text(START).replace(/\s+/g, '')).not.toContain('===null?undefined:')
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：声明、转出与两个模块 infrastructure 的 import 都认得出', () => {
    const probe = join(SRC, 'bootstrap', 'probe.ts')
    expect(
      declaresOrExports(probe, 'export function lazyEvidenceBlobs() {}', 'lazyEvidenceBlobs'),
    ).toBe(true)
    expect(
      declaresOrExports(
        probe,
        "export { selectDaemonHostLifecycle } from './x'",
        'selectDaemonHostLifecycle',
      ),
    ).toBe(true)
    expect(
      infrastructureImports(
        probe,
        [
          "import { a } from '@/modules/system-operations/infrastructure/local/fileDatabaseConfiguration'",
          "import { b } from '@/modules/development-automation/infrastructure/evidenceStore'",
          "import { c } from '@/modules/system-operations/composition/databaseMigration'",
        ].join('\n'),
      ),
    ).toEqual([
      '@/modules/system-operations/infrastructure/local/fileDatabaseConfiguration',
      '@/modules/development-automation/infrastructure/evidenceStore',
    ])
  })
})

describe('RFC-524 ③ 装配处的显式构造', () => {
  test('daemon：开发叠加层的宿主或本机宿主；部署选择的安装或本机文件准备', () => {
    expect(choiceBefore(START, text(START), 'createNativeDaemonHostLifecycle')).toBe(
      'development?.daemonHost',
    )
    expect(callArguments(START, text(START), 'createNativeDaemonHostLifecycle')).toEqual([
      [
        '{infoPath:Paths.daemonInfo,controlPath:Paths.controlFile,pid:process.pid,devWatch:devLockHandoffMs()>0}',
      ],
    ])
    expect(callArguments(RELOAD, text(RELOAD), 'createNativeDaemonHostLifecycle')).toEqual([
      ['{infoPath:Paths.daemonInfo,controlPath:Paths.controlFile,pid:process.pid,devWatch:true}'],
    ])
    const prepare = callArguments(START, text(START), 'prepareDaemonDatabaseProviderForBoot')
    expect(prepare).toHaveLength(1)
    expect(prepare[0]![0]).toContain(
      "...(databaseInstallation===null?{kind:'file'asconst}:{kind:'selected'asconst,installation:databaseInstallation})",
    )
    expect(
      callArguments(DAEMON_DATABASE, text(DAEMON_DATABASE), 'prepareDatabaseProviderForBoot'),
    ).toEqual([
      [
        '{config:input.file.config,contract:input.file.contract,configuration:input.configuration,installation:input.installation}',
      ],
      ['{...input.file,configuration:input.configuration}'],
    ])
  })

  test('迁移、命令与种子：本机配置文件与本机标记在原来回落的位置显式给出', () => {
    for (const path of [SESSION, MIGRATION])
      expect([
        srcPath(path),
        callArguments(path, text(path), 'createFileDatabaseConfiguration'),
      ]).toEqual([srcPath(path), [['Paths.config']]])
    const session = callArguments(SESSION, text(SESSION), 'composeDatabaseMigrationModule')
    expect(session).toHaveLength(1)
    expect(session[0]![0]).toContain('configuration:createFileDatabaseConfiguration(Paths.config)')
    expect(session[0]![0]).not.toContain('configPath')
    expect(callArguments(COMMANDS, text(COMMANDS), 'composeLocalSystemOperations')).toEqual([
      [
        '{repositoryBackupPreparationFactory:composeRepositoryBackupPreparation,contract:logicalSchemaContract,providerRuntime:provider.runtime,databaseConfig:loadConfig(Paths.config).database}',
      ],
      [
        '{repositoryBackupPreparationFactory:composeRepositoryBackupPreparation,contract,providerRuntime,databaseConfig}',
      ],
    ])
    expect(callArguments(MIGRATE, text(MIGRATE), 'prepareManualDatabaseMigration')).toEqual([
      [
        'logicalSchemaContract',
        "options??{kind:'file',configuration:createFileDatabaseConfiguration(Paths.config)}",
      ],
    ])
    expect(
      callArguments(APPLICATION, text(APPLICATION), 'composeLocalInstallationSeedCompletion'),
    ).toEqual([[]])
  })

  test('开发自动化：需求物化器直接核对必填的暂存与写入器；daemon 的任务输入上传给部署选择的证据库', () => {
    expect(callArguments(DA_ROOT, text(DA_ROOT), 'selectedRequirementMaterializerContent')).toEqual(
      [['{staging:deps.requirementStaging,documentCommands:deps.evidenceDocumentCommands}']],
    )
    expect(
      callArguments(DAEMON_DA, text(DAEMON_DA), 'composeMissionInputUploadOperations'),
    ).toEqual([['{db,artifacts:input.evidenceArtifacts}']])
  })

  test('负对照：`??` 的左侧与实参都认得出，不是 `??` 右侧的调用不算', () => {
    const probe = join(SRC, 'probe.ts')
    expect(choiceBefore(probe, 'const h = a?.b ?? make({ x: 1 })', 'make')).toBe('a?.b')
    expect(choiceBefore(probe, 'const h = make({ x: 1 })', 'make')).toBeNull()
    expect(callArguments(probe, 'make({\n  x: 1,\n})', 'make')).toEqual([['{x:1}']])
  })
})

describe('RFC-524 ④ 测试助手与此前回落相同', () => {
  test('开发自动化：给了的原样交出；没给时证据库在装配时建在 <appHome>/evidence，暂存与写入器按它建', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc524-automation-'))
    try {
      const db = {} as PersistenceDb
      const given = {
        evidenceArtifacts: {} as EvidenceArtifactPort,
        admissionLookup: {} as AdmissionLookup,
        requirementStaging: {} as EvidenceStagingFactory,
        evidenceDocumentCommands: {} as EvidenceDocumentCommands,
      }
      const passed = composeStandaloneDevelopmentAutomationSelections({ db, appHome, ...given })
      expect(passed.evidenceArtifacts).toBe(given.evidenceArtifacts)
      expect(passed.admissionLookup).toBe(given.admissionLookup)
      expect(passed.requirementStaging).toBe(given.requirementStaging)
      expect(passed.evidenceDocumentCommands).toBe(given.evidenceDocumentCommands)
      expect(existsSync(join(appHome, 'evidence'))).toBe(false)
      const stagingOnly = composeStandaloneDevelopmentAutomationSelections({
        db,
        appHome,
        evidenceArtifacts: given.evidenceArtifacts,
        admissionLookup: given.admissionLookup,
        requirementStaging: given.requirementStaging,
      })
      expect(stagingOnly.evidenceDocumentCommands).toBeUndefined()
      const built = composeStandaloneDevelopmentAutomationSelections({
        db,
        appHome,
        admissionLookup: given.admissionLookup,
      })
      expect(existsSync(join(appHome, 'evidence', 'blobs'))).toBe(true)
      expect(() => assertEvidenceStagingFactory(built.requirementStaging)).not.toThrow()
      expect(typeof built.evidenceDocumentCommands.writeDocument).toBe('function')
      expect(typeof built.evidenceArtifacts.putBlobFromFile).toBe('function')
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('平台工作项：证据库首次读成员时才建，`then` 不触发构建', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc524-work-items-'))
    try {
      const port = composeStandalonePlatformWorkItemEvidence({ appHome })
      expect((port as unknown as { then?: unknown }).then).toBeUndefined()
      expect(existsSync(join(appHome, 'evidence'))).toBe(false)
      expect(typeof port.putBlobFromFile).toBe('function')
      expect(existsSync(join(appHome, 'evidence', 'blobs'))).toBe(true)
      expect(port.contents).toBeDefined()
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })
})
