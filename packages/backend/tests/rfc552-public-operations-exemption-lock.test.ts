// RFC-552 — public/operations 的类型检查豁免收窄到操作描述工厂（RFC-294 S9 第八步，design §3.2）。
//
// 锁四件事：
// ① 全部模块 `public/operations` 的导出逐名入账，按类分：描述合同（OperationCatalog 的 descriptor 接口与别名）、描述工厂、句柄合同（入站绑定
//    取用的操作接口、视图、输入与 schema）、带后继的旧债（遗留实现在用的仓储构件）。新导出不在清单、或清单里的名字不再导出，都红。
// ② 判据（`rfc294Gates.ts` 的 `publicSurfaceViolations`）：`public/operations` 里取 `@/platform/operations/contracts` 的合同类型不计偏差、
//    但它的类型实参照查；用平台的 `define*Operation` 构造描述的函数跳过；其余导出照常检查；别的 public 入口里合同类型仍按原规则计。
//    各有 fixture 与负对照（同名的本地函数、不调构造器的函数）。
// ③ knowledge-evolution 的五个运维函数不再经 public 导出：`public/operations.ts` 不在，`composition/fusion.ts` 交出它们，bootstrap 从那里取。
// ④ identity-access 的 `OwnerIdentityQueries` 在 `public/queries`、不在 `public/operations`。
//
// 覆盖范围（C12）：① ④ 覆盖全部模块的 `public/operations` 与 identity-access 的 public；② 只在 fixture 上判定（真实语料的偏差清单由
// rfc294-architecture-preflight 的精确清单守住）；③ 覆盖 backend 的 src 全部源码。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { sourceUnit } from './architecture/census'
import { publicSurfaceViolations } from './architecture/rfc294Gates'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const MODULES = join(SRC, 'modules')
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

const specifiersIn = (text: string) =>
  ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName)

function exportedNames(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (ts.isNamedExports(statement.exportClause))
        names.push(...statement.exportClause.elements.map((element) => element.name.text))
      continue
    }
    const exported = ts.canHaveModifiers(statement)
      ? (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false
    if (!exported) continue
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    )
      names.push(statement.name.text)
  }
  return [...new Set(names)].sort()
}

type Kind = 'descriptor contract' | 'descriptor factory' | 'handle contract' | 'debt'
interface ModuleLedger {
  readonly entries: Readonly<Partial<Record<Kind, readonly string[]>>>
  /** Why a `debt` entry is still here and what clears it. */
  readonly successor?: string
}

/** design §3.2: every export of every `public/operations` entry, by class. */
const LEDGER: Readonly<Record<string, ModuleLedger>> = {
  // RFC-579: development-automation's public/operations entry retired with its routes (everything in it was theirs).
  'identity-access': {
    entries: {
      'handle contract': ['IdentityUserOperations'],
      debt: ['DrizzleOidcProviderRepository', 'OidcProviderRepository'],
    },
    successor:
      'the legacy auth/oidc/providers.ts reads the OIDC provider repository; it moves into identity-access (W9-D)',
  },
  memory: {
    // RFC-587: MemoryOperations moved into memory's application with the cascade it carried (no outside consumer).
    entries: { 'handle contract': ['MemoryCatalogOperations'] },
  },
  'resource-catalog': {
    entries: {
      'descriptor contract': [
        // RFC-589: the agent and workgroup descriptors moved into `application/` with their HTTP bindings.
        'McpOperationDescriptors',
        // RFC-581: the skill and plugin descriptors moved into `application/` with their HTTP bindings.
        'ResourcePackageOperationDescriptors',
        // RFC-580: exported for the workflow descriptors that moved into `application/` (every ACL-governed descriptor
        // here extends it); WorkflowOperationDescriptors and WorkgroupTaskRoomModule moved with their HTTP bindings.
        'ResourceAclOperationDescriptors',
      ],
      'handle contract': ['McpCatalogModule', 'ResourcePackageCatalogModule'],
    },
  },
  'source-control': {
    entries: {
      debt: [
        'CachedRepositoryRecord',
        'RepositoryCredentialSealingMutation',
        'RepositoryGroupNodeRecord',
        'RepositoryGroupRecord',
        'RepositoryGroupSnapshot',
        'RepositoryWorkspaceStore',
      ],
    },
    successor:
      'the legacy services/repoCredentials.ts reads the repository workspace store; it moves into source-control (W9-D / W5)',
  },
  'system-operations': {
    entries: {
      // RFC-576: the two descriptor contracts moved into `application/operationDescriptors.ts` with the HTTP bindings.
      'descriptor contract': ['SYSTEM_OPERATION_ALIASES'],
      'handle contract': ['MaintenanceDiskOperations'],
    },
  },
}

describe('RFC-552 —— public/operations 的导出逐名入账（design §3.2）', () => {
  test('有 public/operations 的模块就是清单里的这些', () => {
    const modules = readdirSync(MODULES)
      .filter((name) => existsSync(join(MODULES, name, 'public', 'operations.ts')))
      .sort()
    expect(modules).toEqual(Object.keys(LEDGER).sort())
  })

  test('每个入口的导出与清单逐名相等；旧债都写明后继', () => {
    for (const [module, ledger] of Object.entries(LEDGER)) {
      const path = `modules/${module}/public/operations.ts`
      const listed = Object.values(ledger.entries).flat().sort()
      expect([module, exportedNames(path, read(path))]).toEqual([module, listed])
      expect(new Set(listed).size).toBe(listed.length)
      if ((ledger.entries.debt ?? []).length > 0)
        expect([module, (ledger.successor ?? '').length > 20]).toEqual([module, true])
    }
  })
})

const units = (files: Record<string, string>) =>
  Object.entries(files).map(([path, text]) => sourceUnit(path, text))
const PROBE = 'packages/backend/src/modules/probe/'

describe('RFC-552 —— 判据：豁免只为操作描述工厂而设', () => {
  const DESCRIPTORS =
    "import type { QueryOperationDescriptor } from '@/platform/operations/contracts'\n" +
    'export interface ProbeDescriptors {\n' +
    '  readonly read: QueryOperationDescriptor<{ readonly id: string }, { readonly ok: boolean }, never>\n' +
    '}\n'

  test('public/operations 里取合同类型不计偏差', () => {
    expect(
      publicSurfaceViolations(units({ [PROBE + 'public/operations.ts']: DESCRIPTORS })),
    ).toEqual([])
  })

  test('负对照：别的 public 入口里同一个合同类型仍按原规则计', () => {
    expect(publicSurfaceViolations(units({ [PROBE + 'public/types.ts']: DESCRIPTORS }))).toEqual([
      'modules/probe/public/types.ts#ProbeDescriptors: forbidden type import @/platform/operations/contracts#QueryOperationDescriptor',
    ])
  })

  test('合同类型的类型实参照查：输入里有开放类型仍计', () => {
    expect(
      publicSurfaceViolations(
        units({
          [PROBE + 'public/operations.ts']: DESCRIPTORS.replace(
            'readonly id: string',
            'readonly id: unknown',
          ),
        }),
      ),
    ).toEqual([
      'modules/probe/public/operations.ts#ProbeDescriptors: unsafe/open type UnknownKeyword',
    ])
  })

  const factory = (builderImport: string, form: 'declaration' | 'const') =>
    `${builderImport}\n` +
    (form === 'declaration'
      ? 'export function createProbeDescriptors(run: (input: unknown) => void) {\n' +
        '  return Object.freeze({ read: define({ invoke: run }) })\n' +
        '}\n'
      : 'export const createProbeDescriptors = (run: (input: unknown) => void) =>\n' +
        '  Object.freeze({ read: define({ invoke: run }) })\n')

  test('用平台构造器构造描述的函数跳过（声明与 const 两种写法，含别名 import）', () => {
    for (const builder of ['defineQueryOperation', 'defineCommandOperation'])
      for (const form of ['declaration', 'const'] as const)
        expect([
          builder,
          form,
          publicSurfaceViolations(
            units({
              [PROBE + 'public/operations.ts']: factory(
                `import { ${builder} as define } from '@/platform/operations/definitions'`,
                form,
              ),
            }),
          ),
        ]).toEqual([builder, form, []])
  })

  test('负对照：同名的本地函数、别处来的构造器都不算描述工厂', () => {
    // RFC-604: the callback parameter itself is part of the function's signature (rule two); the `unknown` it takes is
    // still reported, which is what shows the declaration is checked rather than skipped.
    const expected = [
      'modules/probe/public/operations.ts#createProbeDescriptors: unsafe/open type UnknownKeyword',
    ]
    expect(
      publicSurfaceViolations(
        units({
          [PROBE + 'public/operations.ts']: factory(
            'const define = (input: { readonly invoke: (input: unknown) => void }) => input',
            'declaration',
          ),
        }),
      ),
    ).toEqual(expected)
    expect(
      publicSurfaceViolations(
        units({
          [PROBE + 'public/operations.ts']: factory(
            "import { defineQueryOperation as define } from '@/platform/operations/elsewhere'",
            'declaration',
          ),
        }),
      ),
    ).toEqual(expected)
  })

  test('public/operations 里的非描述导出照常检查（仓储接口里的 Partial 仍计）', () => {
    expect(
      publicSurfaceViolations(
        units({
          [PROBE + 'public/operations.ts']:
            'export interface ProbeRepository {\n' +
            '  patch(input: Partial<{ readonly id: string }>): Promise<void>\n' +
            '}\n',
        }),
      ),
    ).toEqual(['modules/probe/public/operations.ts#ProbeRepository: forbidden type Partial'])
  })
})

describe('RFC-552 —— knowledge-evolution 的运维函数由 composition 交给 bootstrap', () => {
  const MAINTENANCE = [
    'reconcileFusion',
    'reconcileRunningFusions',
    'recoverFusionDecisions',
    'repairFusionProvenance',
    'seedFusionResources',
  ]

  test('public/operations.ts 不在；composition/fusion 交出五个运维函数', () => {
    expect(existsSync(join(MODULES, 'knowledge-evolution', 'public', 'operations.ts'))).toBe(false)
    const fusion = 'modules/knowledge-evolution/composition/fusion.ts'
    expect(exportedNames(fusion, read(fusion))).toEqual(expect.arrayContaining(MAINTENANCE))
  })

  test('backend src 零 import 旧入口，bootstrap 的静态与动态取用都改从 composition/fusion', () => {
    const sources = walk(SRC)
    expect(sources.length).toBeGreaterThanOrEqual(1500)
    const retired = sources.flatMap((path) =>
      specifiersIn(readFileSync(path, 'utf8'))
        .filter((specifier) => specifier === '@/modules/knowledge-evolution/public/operations')
        .map((specifier) => `${slash(relative(REPO_ROOT, path))} -> ${specifier}`),
    )
    expect(retired).toEqual([])
    for (const path of ['bootstrap/daemonSession.ts', 'bootstrap/daemonApplication.ts'])
      expect([path, specifiersIn(read(path))]).toEqual([
        path,
        expect.arrayContaining(['@/modules/knowledge-evolution/composition/fusion']),
      ])
  }, 60_000)
})

describe('RFC-552 —— knowledge-evolution 的连锁撤出（运维函数离开 public 后，只经它们签名可达的端口与记录）', () => {
  const KE = 'modules/knowledge-evolution/'
  const MOVED: Readonly<Record<string, readonly string[]>> = {
    [KE + 'application/ports/fusionOperations.ts']: ['FusionOperations'],
    [KE + 'application/ports/fusionPersistence.ts']: [
      'FusionApplyCommand',
      'FusionBuiltinAgentSeed',
      'FusionDecisionClaimInput',
      'FusionDecisionRecoveryReceipt',
      'FusionPersistence',
      'FusionPersistencePatch',
      'FusionProvenanceRepairReceipt',
      'FusionResourceSeed',
      'FusionSkillAccess',
      'FusionSkillIdentity',
      'FusionStatusCas',
    ],
    // Used by the domain's seed and row mapping, so they live there (domain does not take application).
    [KE + 'domain/fusionWorkflowSeed.ts']: ['FusionBuiltinWorkflowSeed'],
    [KE + 'domain/fusionRow.ts']: ['FusionPersistenceRecord'],
  }

  test('在新位置导出，不在 knowledge-evolution 任一 public 文件里', () => {
    const publicDir = join(MODULES, 'knowledge-evolution', 'public')
    const publicExports = readdirSync(publicDir)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) => {
        const path = `${KE}public/${name}`
        return exportedNames(path, read(path))
      })
    let moved = 0
    for (const [path, names] of Object.entries(MOVED)) {
      const exported = exportedNames(path, read(path))
      for (const name of names) {
        moved += 1
        expect([path, name, exported.includes(name)]).toEqual([path, name, true])
        expect([name, publicExports.includes(name)]).toEqual([name, false])
      }
    }
    expect(moved).toBe(14)
  })

  test('domain 不取 application', () => {
    for (const path of [KE + 'domain/fusionWorkflowSeed.ts', KE + 'domain/fusionRow.ts'])
      expect([path, specifiersIn(read(path)).filter((s) => /\/application(\/|$)/.test(s))]).toEqual(
        [path, []],
      )
  })
})

describe('RFC-552 —— OwnerIdentityQueries 是查询端口', () => {
  test('在 identity-access 的 public/queries，不在 public/operations', () => {
    expect(
      exportedNames(
        'modules/identity-access/public/queries.ts',
        read('modules/identity-access/public/queries.ts'),
      ),
    ).toContain('OwnerIdentityQueries')
    expect(
      exportedNames(
        'modules/identity-access/public/operations.ts',
        read('modules/identity-access/public/operations.ts'),
      ),
    ).not.toContain('OwnerIdentityQueries')
  })
})
