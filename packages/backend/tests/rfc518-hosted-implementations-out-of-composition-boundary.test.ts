// RFC-518 — 托管实现迁出组合层（一）：RFC-370 余项里 23 个自足的文件（RFC-294 S10 第二十五步）。
//
// 锁三件事（design §3 的清单即退出门）：
// ① 23 个文件只在各模块的 `infrastructure/crewstation/` 下、旧路径不存在，导出的名字逐个钉住；RFC-515 门的例外清单恰是余下的 4 个。
// ② 全部生产文件里没有 import 指向旧路径；bootstrap 不深引用任何模块的 infrastructure；模块根转出的名字与新位置导出的是同一个对象。
// ③ 新位置不取组合层，例外只有两处本模块 `required-ports` 的类型 import（逐条钉住，带负对照）。
//
// 覆盖范围（C12）：② 读全部生产文件（语料下限 3,000）与 bootstrap；① ③ 读 23 个新位置与全部模块的组合层。迁移代码的行为由既有的
// RFC-370 用例覆盖（它们改从新路径 import）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const MOVED: Readonly<Record<string, readonly string[]>> = {
  'modules/development-automation/infrastructure/crewstation/crewstationEvidence': [
    'composeCrewStationDevelopmentEvidence',
  ],
  'modules/development-automation/infrastructure/crewstation/crewstationEvidenceStaging': [
    'composeCrewStationEvidenceStaging',
  ],
  'modules/development-automation/infrastructure/crewstation/crewstationVerification': [
    'createCrewStationVerificationCommandEffectsFactory',
  ],
  'modules/development-automation/infrastructure/crewstation/crewstationWorkspace': [
    'composeCrewStationDevelopmentWorkspaces',
  ],
  'modules/development-automation/infrastructure/crewstation/taskImageEvidence': [
    'requireEvidenceWorkPath',
    'executeTaskImageEvidence',
  ],
  'modules/development-automation/infrastructure/crewstation/taskImageVerification': [
    'HostedVerificationReceipt',
    'executeTaskImageVerification',
  ],
  'modules/development-automation/infrastructure/crewstation/taskImageWorkspace': [
    'DEVELOPMENT_TREE_OPERATION',
    'DEVELOPMENT_TREE_INLINE_BYTES',
    'DEVELOPMENT_TREE_SCRATCH',
    'DevelopmentTreeOutcome',
    'TASK_IMAGE_DEVELOPMENT_OPERATIONS',
    'executeTaskImageDevelopmentOperation',
  ],
  'modules/digital-employee/infrastructure/crewstation/crewstationContent': [
    'EMPLOYEE_CONTENT_OWNER',
    'composeCrewStationEmployeeContent',
  ],
  'modules/event-center/infrastructure/crewstation/taskImageObserver': [
    'TASK_IMAGE_OBSERVER_OPERATIONS',
    'executeTaskImageObserver',
  ],
  'modules/integration/infrastructure/crewstation/crewstationDevelopmentAdapters': [
    'composeCrewStationDevelopmentAdapters',
  ],
  'modules/integration/infrastructure/crewstation/taskImageDevelopmentAdapter': [
    'executeTaskImageDevelopmentAdapter',
  ],
  'modules/intent/infrastructure/crewstation/crewstationScratch': [
    'composeCrewStationIntentScratchStore',
  ],
  'modules/resource-catalog/infrastructure/crewstation/crewstationArtifacts': [
    'composeCrewStationResourceArtifacts',
  ],
  'modules/resource-catalog/infrastructure/crewstation/crewstationNativePlugin': [
    'createHostedNativePluginReader',
  ],
  'modules/resource-catalog/infrastructure/crewstation/taskImagePlugin': [
    'TaskImagePluginFile',
    'TaskImagePluginResult',
    'executeTaskImagePlugin',
  ],
  'modules/runtime-management/infrastructure/crewstation/crewstationSystemAgentMaterial': [
    'composeCrewStationSystemAgentContents',
  ],
  'modules/runtime-management/infrastructure/crewstation/taskImageMaterial': [
    'executeTaskImageSystemWorkspace',
  ],
  'modules/source-control/infrastructure/crewstation/crewstationWorkspace': [
    'composeCrewStationWorkspaceOwner',
  ],
  'modules/source-control/infrastructure/crewstation/taskImageIsolation': [
    'executeTaskImageIsolationMergeStep',
  ],
  'modules/source-control/infrastructure/crewstation/taskImageRepositoryEffects': [
    'TASK_IMAGE_REPOSITORY_OPERATIONS',
    'platformPublicationSession',
    'executeTaskImageRepositoryOperation',
  ],
  'modules/source-control/infrastructure/crewstation/taskImageUploads': [
    'TASK_IMAGE_UPLOAD_OPERATIONS',
    'executeTaskImageUploadOperation',
  ],
  'modules/source-control/infrastructure/crewstation/taskImageWorkspace': [
    'executeTaskImageWorkspaceOperation',
  ],
  'modules/system-operations/infrastructure/crewstation/crewstationDatabaseRestore': [
    'HOSTED_RESTORE_REFERENCE_ENV',
    'restoreCrewStationDatabaseFromEnvironment',
    'verifyCrewStationDatabaseRestore',
  ],
}
const STAYING = [
  'modules/intent/composition/crewstationArtifacts',
  'modules/resource-catalog/composition/crewstationMcpDiagnostics',
  'modules/runtime-management/composition/crewstationRuntimeManagement',
  'modules/system-operations/composition/crewstationDeployment',
]
/** design D2: what each module root hands bootstrap, by the infrastructure file it comes from. */
const ROOT_EXPORTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'development-automation': {
    crewstationEvidence: ['composeCrewStationDevelopmentEvidence'],
    crewstationEvidenceStaging: ['composeCrewStationEvidenceStaging'],
    crewstationVerification: ['createCrewStationVerificationCommandEffectsFactory'],
    crewstationWorkspace: ['composeCrewStationDevelopmentWorkspaces'],
    taskImageEvidence: ['executeTaskImageEvidence'],
    taskImageVerification: ['executeTaskImageVerification'],
    taskImageWorkspace: [
      'executeTaskImageDevelopmentOperation',
      'TASK_IMAGE_DEVELOPMENT_OPERATIONS',
    ],
  },
  'digital-employee': {
    crewstationContent: ['composeCrewStationEmployeeContent'],
  },
  'event-center': {
    taskImageObserver: ['executeTaskImageObserver', 'TASK_IMAGE_OBSERVER_OPERATIONS'],
  },
  integration: {
    crewstationDevelopmentAdapters: ['composeCrewStationDevelopmentAdapters'],
    taskImageDevelopmentAdapter: ['executeTaskImageDevelopmentAdapter'],
  },
  intent: {
    crewstationScratch: ['composeCrewStationIntentScratchStore'],
  },
  'resource-catalog': {
    crewstationArtifacts: ['composeCrewStationResourceArtifacts'],
    crewstationNativePlugin: ['createHostedNativePluginReader'],
    taskImagePlugin: ['executeTaskImagePlugin'],
  },
  'runtime-management': {
    crewstationSystemAgentMaterial: ['composeCrewStationSystemAgentContents'],
    taskImageMaterial: ['executeTaskImageSystemWorkspace'],
  },
  'source-control': {
    crewstationWorkspace: ['composeCrewStationWorkspaceOwner'],
    taskImageWorkspace: ['executeTaskImageWorkspaceOperation'],
  },
  'system-operations': {
    crewstationDatabaseRestore: ['verifyCrewStationDatabaseRestore'],
  },
}
/** design §1: the only composition imports of the 23 files — their own module's required-port types. */
const REQUIRED_PORT_IMPORTS: readonly string[] = [
  'modules/digital-employee/infrastructure/crewstation/crewstationContent -> modules/digital-employee/composition/required-ports (type)',
  'modules/source-control/infrastructure/crewstation/crewstationWorkspace -> modules/source-control/composition/required-ports (type)',
]
const INFRASTRUCTURE_MODULES: Readonly<Record<string, () => Promise<Record<string, unknown>>>> = {
  'modules/development-automation/infrastructure/crewstation/crewstationEvidence': () =>
    import('@/modules/development-automation/infrastructure/crewstation/crewstationEvidence'),
  'modules/development-automation/infrastructure/crewstation/crewstationEvidenceStaging': () =>
    import('@/modules/development-automation/infrastructure/crewstation/crewstationEvidenceStaging'),
  'modules/development-automation/infrastructure/crewstation/crewstationVerification': () =>
    import('@/modules/development-automation/infrastructure/crewstation/crewstationVerification'),
  'modules/development-automation/infrastructure/crewstation/crewstationWorkspace': () =>
    import('@/modules/development-automation/infrastructure/crewstation/crewstationWorkspace'),
  'modules/development-automation/infrastructure/crewstation/taskImageEvidence': () =>
    import('@/modules/development-automation/infrastructure/crewstation/taskImageEvidence'),
  'modules/development-automation/infrastructure/crewstation/taskImageVerification': () =>
    import('@/modules/development-automation/infrastructure/crewstation/taskImageVerification'),
  'modules/development-automation/infrastructure/crewstation/taskImageWorkspace': () =>
    import('@/modules/development-automation/infrastructure/crewstation/taskImageWorkspace'),
  'modules/digital-employee/infrastructure/crewstation/crewstationContent': () =>
    import('@/modules/digital-employee/infrastructure/crewstation/crewstationContent'),
  'modules/event-center/infrastructure/crewstation/taskImageObserver': () =>
    import('@/modules/event-center/infrastructure/crewstation/taskImageObserver'),
  'modules/integration/infrastructure/crewstation/crewstationDevelopmentAdapters': () =>
    import('@/modules/integration/infrastructure/crewstation/crewstationDevelopmentAdapters'),
  'modules/integration/infrastructure/crewstation/taskImageDevelopmentAdapter': () =>
    import('@/modules/integration/infrastructure/crewstation/taskImageDevelopmentAdapter'),
  'modules/intent/infrastructure/crewstation/crewstationScratch': () =>
    import('@/modules/intent/infrastructure/crewstation/crewstationScratch'),
  'modules/resource-catalog/infrastructure/crewstation/crewstationArtifacts': () =>
    import('@/modules/resource-catalog/infrastructure/crewstation/crewstationArtifacts'),
  'modules/resource-catalog/infrastructure/crewstation/crewstationNativePlugin': () =>
    import('@/modules/resource-catalog/infrastructure/crewstation/crewstationNativePlugin'),
  'modules/resource-catalog/infrastructure/crewstation/taskImagePlugin': () =>
    import('@/modules/resource-catalog/infrastructure/crewstation/taskImagePlugin'),
  'modules/runtime-management/infrastructure/crewstation/crewstationSystemAgentMaterial': () =>
    import('@/modules/runtime-management/infrastructure/crewstation/crewstationSystemAgentMaterial'),
  'modules/runtime-management/infrastructure/crewstation/taskImageMaterial': () =>
    import('@/modules/runtime-management/infrastructure/crewstation/taskImageMaterial'),
  'modules/source-control/infrastructure/crewstation/crewstationWorkspace': () =>
    import('@/modules/source-control/infrastructure/crewstation/crewstationWorkspace'),
  'modules/source-control/infrastructure/crewstation/taskImageWorkspace': () =>
    import('@/modules/source-control/infrastructure/crewstation/taskImageWorkspace'),
  'modules/system-operations/infrastructure/crewstation/crewstationDatabaseRestore': () =>
    import('@/modules/system-operations/infrastructure/crewstation/crewstationDatabaseRestore'),
}
const ROOT_MODULES: Readonly<Record<string, () => Promise<Record<string, unknown>>>> = {
  'development-automation': () => import('@/modules/development-automation/composition'),
  'digital-employee': () => import('@/modules/digital-employee/composition'),
  'event-center': () => import('@/modules/event-center/composition'),
  integration: () => import('@/modules/integration/composition'),
  intent: () => import('@/modules/intent/composition'),
  'resource-catalog': () => import('@/modules/resource-catalog/composition'),
  'runtime-management': () => import('@/modules/runtime-management/composition'),
  'source-control': () => import('@/modules/source-control/composition'),
  'system-operations': () => import('@/modules/system-operations/composition'),
}
const oldLocation = (location: string) =>
  location.replace('/infrastructure/crewstation/', '/composition/')

/** The tests below read every production file; the first pays the cold read. */
const CORPUS_TIMEOUT = 30_000

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
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
const srcPath = (abs: string) => slash(relative(SRC, abs)).replace(/\.tsx?$/, '')
const sourceOf = (location: string) => join(SRC, `${location}.ts`)
/** `@/…` and relative specifiers as a path under `src` without extension; packages yield null. */
const resolveSpecifier = (file: string, specifier: string) =>
  specifier.startsWith('@/')
    ? srcPath(join(SRC, specifier.slice(2)))
    : specifier.startsWith('.')
      ? srcPath(resolve(dirname(file), specifier))
      : null

function declaredNames(path: string, source: string): string[] {
  const names: string[] = []
  for (const statement of parse(path, source).statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    )
      names.push(statement.name.text)
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
  }
  return names
}

function offeredNames(path: string, source: string): string[] {
  const names: string[] = []
  for (const statement of parse(path, source).statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (exported) names.push(...declaredNames(path, statement.getFullText()))
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements) names.push(element.name.text)
  }
  return names
}

/** Every static import or re-export of the file as `kind specifier: names` (resolved under `src`; packages as written). */
function moduleEdges(file: string, source: string): string[] {
  const out: string[] = []
  for (const statement of parse(file, source).statements) {
    if (
      !(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue
    const from =
      resolveSpecifier(file, statement.moduleSpecifier.text) ?? statement.moduleSpecifier.text
    let names = ['<other>']
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings
      if (bindings !== undefined && ts.isNamedImports(bindings))
        names = bindings.elements.map((element) => (element.propertyName ?? element.name).text)
    } else if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause))
      names = statement.exportClause.elements.map(
        (element) => (element.propertyName ?? element.name).text,
      )
    out.push(
      `${ts.isImportDeclaration(statement) ? 'import' : 'export'} ${from}: ${names.join(', ')}`,
    )
  }
  return out
}

/** Imports of the file that resolve into any composition file, with their kind (read from the syntax tree). */
function compositionImports(file: string, source: string): string[] {
  const out: string[] = []
  for (const statement of parse(file, source).statements) {
    if (
      !(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue
    const resolved = resolveSpecifier(file, statement.moduleSpecifier.text)
    if (resolved === null || !/^modules\/[^/]+\/composition(\/|$)/.test(resolved)) continue
    const typeOnly = ts.isImportDeclaration(statement)
      ? statement.importClause?.isTypeOnly === true
      : statement.isTypeOnly
    out.push(`${srcPath(file)} -> ${resolved} (${typeOnly ? 'type' : 'value'})`)
  }
  return out
}

describe('RFC-518 ① 23 个托管实现只在 infrastructure/crewstation', () => {
  test('新位置存在、旧位置不存在，导出的名字逐个钉住', () => {
    expect(Object.keys(MOVED)).toHaveLength(23)
    for (const [location, names] of Object.entries(MOVED)) {
      const path = sourceOf(location)
      expect([location, existsSync(path), existsSync(sourceOf(oldLocation(location)))]).toEqual([
        location,
        true,
        false,
      ])
      expect([location, offeredNames(path, text(path))]).toEqual([location, [...names]])
    }
  })

  test('RFC-515 门的例外清单恰是留在组合层的 4 个', () => {
    const gate = text(
      join(BACKEND, 'tests', 'architecture', 'rfc515-composition-assembly-only.test.ts'),
    )
    const listed = [...gate.matchAll(/\[MODULES \+ '([^']+)'\]/g)].map(
      (match) => `modules/${match[1]!.replace(/\.ts$/, '')}`,
    )
    expect(listed.sort()).toEqual([...STAYING].sort())
    for (const location of STAYING)
      expect([location, existsSync(sourceOf(location))]).toEqual([location, true])
  })
})

describe('RFC-518 ② 消费方经模块根取', () => {
  test(
    '全部生产文件里没有 import 指向旧路径；bootstrap 不深引用模块 infrastructure（语料下限 3,000）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      const old = new Set(Object.keys(MOVED).map(oldLocation))
      const stale = PRODUCTION.flatMap((path) =>
        moduleEdges(path, text(path))
          .map((edge) => edge.split(': ')[0]!.split(' ')[1]!)
          .filter((target) => old.has(target))
          .map((target) => `${srcPath(path)} -> ${target}`),
      )
      expect(stale).toEqual([])
      const bootstrap = PRODUCTION.filter((path) => srcPath(path).startsWith('bootstrap/'))
      expect(bootstrap.length).toBeGreaterThan(20)
      expect(
        bootstrap.flatMap((path) =>
          moduleEdges(path, text(path))
            .filter((edge) => /^(import|export) modules\/[^/]+\/infrastructure\//.test(edge))
            .map((edge) => `${srcPath(path)}: ${edge}`),
        ),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test(
    '模块根转出的名字与新位置导出的是同一个对象',
    async () => {
      for (const [module, files] of Object.entries(ROOT_EXPORTS)) {
        const root = await ROOT_MODULES[module]!()
        for (const [file, names] of Object.entries(files)) {
          const location = `modules/${module}/infrastructure/crewstation/${file}`
          const infrastructure = await INFRASTRUCTURE_MODULES[location]!()
          for (const name of names) {
            expect([location, name, typeof infrastructure[name]]).not.toEqual([
              location,
              name,
              'undefined',
            ])
            expect([location, name, root[name] === infrastructure[name]]).toEqual([
              location,
              name,
              true,
            ])
          }
        }
      }
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-518 ③ 新位置不取组合层', () => {
  test('23 个文件只有两处本模块 required-ports 的类型 import', () => {
    expect(
      Object.keys(MOVED).flatMap((location) =>
        compositionImports(sourceOf(location), text(sourceOf(location))),
      ),
    ).toEqual([...REQUIRED_PORT_IMPORTS])
  })

  test('负对照：取组合文件、取别的模块的组合文件与取 required-ports 的值都会被认出', () => {
    const file = sourceOf('modules/intent/infrastructure/crewstation/probe')
    const source = [
      `import type { IntentArtifactSelection } from '../../composition/apply'`,
      `import { composeRuntimeManagement } from '@/modules/runtime-management/composition/runtimeManagement'`,
      `import { RUNTIME_PORT } from '../../composition/required-ports'`,
      `import type { IntentPort } from '../../composition/required-ports'`,
      `export { composeIntent } from '../../composition'`,
      `import { selectApply } from '../../application/apply'`,
    ].join('\n')
    expect(compositionImports(file, source)).toEqual([
      'modules/intent/infrastructure/crewstation/probe -> modules/intent/composition/apply (type)',
      'modules/intent/infrastructure/crewstation/probe -> modules/runtime-management/composition/runtimeManagement (value)',
      'modules/intent/infrastructure/crewstation/probe -> modules/intent/composition/required-ports (value)',
      'modules/intent/infrastructure/crewstation/probe -> modules/intent/composition/required-ports (type)',
      'modules/intent/infrastructure/crewstation/probe -> modules/intent/composition (value)',
    ])
  })
})
