// RFC-609 — 能力模板的 PostgreSQL 归属方经指定 adapter 取资源目录的端口合同（RFC-294 S9 余项：跨 context 内部文件对 4 → 2）。
//
// 为什么存在：资源包 PostgreSQL 事务里能力模板那一支的 owner-native 实现（code-capability 的
// `postgresqlCapabilityTemplatePackageMutationOwner.ts`）此前直接 import resource-catalog infrastructure 的两个文件——合同接口在资源包参与方
// 文件里，事务类型在 `repositorySupport.ts` 里（只是平台 `PersistenceTx` 的别名）——占全仓 4 条跨 context 内部文件对里的 2 条。现在合同是
// resource-catalog 的 application 端口，经 `composition/required-ports` 交出；实现只从自己的指定 adapter 取它（只取类型），事务直接用平台的
// `PersistenceTx`。锁五件事：
// ① 归属方文件不 import resource-catalog 的任何文件；合同取自指定 adapter，事务类型取自平台。
// ② 指定 adapter 只以 `import type` 取 `@/modules/resource-catalog/composition/required-ports`，自己只转出类型。
// ③ 合同声明在 resource-catalog 的 application 端口里，资源包参与方文件不再声明它、改从端口取；required-ports 交出它。
// ④ 架构门在真实语料上没有从 code-capability 出发的跨 context 内部文件对（语料下限 3,000）。
// ⑤ 编译期：归属方工厂的返回值就是 required-ports 交出的合同。
// ①② 的判据也喂伪造源码做负对照，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import type { CapabilityTemplatePackageMutationOwner } from '@/modules/resource-catalog/composition/required-ports'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'
import { createGateCorpus, crossContextInternalPairs } from './architecture/rfc294Gates'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const OWNER =
  SRC + 'modules/code-capability/infrastructure/postgresqlCapabilityTemplatePackageMutationOwner.ts'
const ADAPTER = SRC + 'modules/code-capability/application/adapters/resource-catalog-adapter.ts'
const PORT = SRC + 'modules/resource-catalog/application/ports/capabilityTemplatePackageOwner.ts'
const PARTICIPANTS =
  SRC +
  'modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants.ts'
const REQUIRED_PORTS = SRC + 'modules/resource-catalog/composition/required-ports.ts'
const CONTRACT = 'CapabilityTemplatePackageMutationOwner'
const RC_REQUIRED_PORTS = '@/modules/resource-catalog/composition/required-ports'
const CORPUS_TIMEOUT = 60_000

// ⑤ The owner factory returns exactly the contract Resource Catalog offers through its required ports.
type Assert<T extends true> = T
export type OwnerImplementsRequiredPort = Assert<
  ReturnType<
    typeof createPostgresqlCapabilityTemplatePackageMutationOwner
  > extends CapabilityTemplatePackageMutationOwner
    ? true
    : false
>

const read = (path: string): SourceUnit =>
  sourceUnit(path, readFileSync(resolve(REPO, path), 'utf8'))

interface ImportFact {
  readonly specifier: string
  readonly typeOnly: boolean
  readonly names: readonly string[]
}

function importsOf(unit: SourceUnit): ImportFact[] {
  const facts: ImportFact[] = []
  for (const statement of unit.source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined
      const bindings = ts.isImportDeclaration(statement)
        ? clause?.namedBindings
        : statement.exportClause
      const names =
        bindings !== undefined && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
          ? bindings.elements.map((element) => element.name.text)
          : []
      facts.push({
        specifier: statement.moduleSpecifier.text,
        typeOnly: ts.isImportDeclaration(statement)
          ? clause?.isTypeOnly === true
          : statement.isTypeOnly,
        names,
      })
    }
  }
  return facts
}

/** ①: what the owner file takes from where. */
function ownerFindings(unit: SourceUnit): string[] {
  const findings: string[] = []
  const imports = importsOf(unit)
  for (const fact of imports)
    if (fact.specifier.startsWith('@/modules/resource-catalog'))
      findings.push(`resource-catalog import:${fact.specifier}`)
  const contract = imports.filter((fact) => fact.names.includes(CONTRACT))
  if (
    contract.length !== 1 ||
    contract[0]!.specifier !== '../application/adapters/resource-catalog-adapter' ||
    !contract[0]!.typeOnly
  )
    findings.push('contract not taken from the designated adapter')
  if (
    !imports.some(
      (fact) =>
        fact.specifier === '@/platform/persistence/persistenceDb' &&
        fact.typeOnly &&
        fact.names.includes('PersistenceTx'),
    )
  )
    findings.push('transaction not typed by the platform')
  return findings
}

/** ②: the designated adapter takes Resource Catalog's types only, from its required ports. */
function adapterFindings(unit: SourceUnit): string[] {
  const findings: string[] = []
  for (const fact of importsOf(unit)) {
    if (!fact.specifier.startsWith('@/modules/')) continue
    if (fact.specifier !== RC_REQUIRED_PORTS) findings.push(`not required ports:${fact.specifier}`)
    if (!fact.typeOnly) findings.push(`value import:${fact.specifier}`)
  }
  for (const statement of unit.source.statements) {
    const exported = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false
    if (exported && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement))
      findings.push(`value export:${statement.getText(unit.source).split('\n')[0]}`)
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly)
      findings.push(`value re-export:${statement.getText(unit.source)}`)
  }
  return findings
}

const declaresContract = (unit: SourceUnit) =>
  unit.source.statements.some(
    (statement) =>
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      statement.name.text === CONTRACT,
  )

describe('RFC-609 —— 能力模板归属方经指定 adapter 取资源目录的端口合同', () => {
  test('归属方不 import resource-catalog，合同取自指定 adapter，事务类型取自平台', () => {
    expect(ownerFindings(read(OWNER))).toEqual([])
  })

  test('指定 adapter 只以 import type 取 resource-catalog 的 required-ports', () => {
    const adapter = read(ADAPTER)
    expect(importsOf(adapter).map((fact) => fact.specifier)).toEqual([RC_REQUIRED_PORTS])
    expect(adapterFindings(adapter)).toEqual([])
  })

  test('合同声明在 application 端口，参与方文件改从端口取，required-ports 交出它', () => {
    expect(declaresContract(read(PORT))).toBe(true)
    const participants = read(PARTICIPANTS)
    expect(declaresContract(participants)).toBe(false)
    expect(importsOf(participants).filter((fact) => fact.names.includes(CONTRACT))).toEqual([
      {
        specifier: '../../application/ports/capabilityTemplatePackageOwner',
        typeOnly: true,
        names: [CONTRACT],
      },
    ])
    expect(importsOf(read(REQUIRED_PORTS)).filter((fact) => fact.names.includes(CONTRACT))).toEqual(
      [
        {
          specifier: '../application/ports/capabilityTemplatePackageOwner',
          typeOnly: true,
          names: [CONTRACT],
        },
      ],
    )
  })

  test(
    '真实语料上没有从 code-capability 出发的跨 context 内部文件对',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(
        crossContextInternalPairs(createGateCorpus(units)).filter((pair) =>
          pair.startsWith(SRC + 'modules/code-capability/'),
        ),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-609 —— 负对照（伪造源码）', () => {
  test('归属方直接取 resource-catalog infrastructure 的合同与事务类型会被认出', () => {
    const owner = sourceUnit(
      OWNER,
      [
        "import type { PersistenceDb } from '@/platform/persistence/persistenceDb'",
        `import type { ${CONTRACT} } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants'`,
        "import type { PostgresqlResourceCatalogTransaction } from '@/modules/resource-catalog/infrastructure/postgresql/repositorySupport'",
      ].join('\n'),
    )
    expect(ownerFindings(owner)).toEqual([
      'resource-catalog import:@/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants',
      'resource-catalog import:@/modules/resource-catalog/infrastructure/postgresql/repositorySupport',
      'contract not taken from the designated adapter',
      'transaction not typed by the platform',
    ])
  })

  test('adapter 取值、取别的入口或转出值会被认出', () => {
    const adapter = sourceUnit(
      ADAPTER,
      [
        `import { ${CONTRACT} } from '${RC_REQUIRED_PORTS}'`,
        "import type { Other } from '@/modules/resource-catalog/infrastructure/other'",
        `export { ${CONTRACT} }`,
        'export const leaked = 1',
      ].join('\n'),
    )
    expect(adapterFindings(adapter)).toEqual([
      `value import:${RC_REQUIRED_PORTS}`,
      'not required ports:@/modules/resource-catalog/infrastructure/other',
      `value re-export:export { ${CONTRACT} }`,
      'value export:export const leaked = 1',
    ])
  })
})
