import type { ProviderNeutralDatabase } from '../../src/db/query'
import type { SecretBox } from '../../src/auth/secretBox'
import type { Actor } from '../../src/auth/actor'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '../../src/modules/code-capability/composition/capabilityTemplateOperations'
import { createMcpTransactionLifecycle } from '../../src/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import {
  composePostgresqlResourcePackageCatalog,
  composePostgresqlResourcePackageProvider,
} from '../../src/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '../../src/platform/persistence/postgresqlResourcePackageAtomicApply'
import { createResourcePackageReadPort } from '../../src/modules/resource-catalog/infrastructure/packageResourceRows'
import { readPackageSkillTree } from '../../src/modules/resource-catalog/infrastructure/packageSkillTree'
import { createPostgresqlResourcePackageExecutionAdapter } from '../../src/services/resourcePackage/executionAdapter'
import { createResourcePackagePluginInstaller } from '../../src/services/resourcePackage/pluginInstallerAdapter'
import { walkExportClosureFromReadPort } from '../../src/services/resourcePackage/closure'
import { exportResourcePackageFromReadPort } from '../../src/services/resourcePackage/export'
import { buildPackagePreviewFromReadPort } from '../../src/services/resourcePackage/preview'

type ClosureParameters = Parameters<typeof walkExportClosureFromReadPort>
type PreviewParameters = Parameters<typeof buildPackagePreviewFromReadPort>
type ExportParameters = Parameters<typeof exportResourcePackageFromReadPort>

/**
 * RFC-359 —— 两台 apply 引擎合一后，**测试装的就是生产装的那一条**（此前这里装的是
 * SQLite 专属的 `createSqliteResourcePackageExecutionAdapter`，而生产 PostgreSQL 那台装的
 * 是原子 apply——判据于是只跑在一台机器上）。
 *
 * apply 会话在 `create()` 里把 `context.authority` 解回 Actor 并与传入的 Actor 对照，所以夹具
 * 必须说清「这条装配代表谁」：给 `actor` 就认它，多身份用例自带 `authorityResolver`。
 */
export function composeSqliteResourcePackageCatalogForTest(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly box: SecretBox
  readonly actor?: Actor
  readonly authorityResolver?: Parameters<
    typeof composePostgresqlResourcePackageProvider
  >[0]['authorityResolver']
}) {
  const actor = input.actor
  const provider = composePostgresqlResourcePackageProvider({
    db: input.db,
    appHome: input.appHome,
    authorityResolver: input.authorityResolver ?? {
      resolve: () => {
        if (actor === undefined) throw new Error('resource-package-test-actor-not-provided')
        return actor
      },
    },
    mcpLifecycle: createMcpTransactionLifecycle(),
    capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({ db: input.db }),
    pluginInstaller: createResourcePackagePluginInstaller(),
  })
  return composePostgresqlResourcePackageCatalog({
    provider,
    execution: createPostgresqlResourcePackageExecutionAdapter({
      box: input.box,
      provider,
      atomicApply: createPostgresqlResourcePackageAtomicApplyOperations({
        db: input.db,
        box: input.box,
      }),
    }),
  })
}

/** Test-only SQLite binding for the provider-neutral package closure. */
export function walkExportClosure(
  db: ProviderNeutralDatabase,
  actor: ClosureParameters[1],
  root: ClosureParameters[2],
): ReturnType<typeof walkExportClosureFromReadPort> {
  return walkExportClosureFromReadPort(createResourcePackageReadPort(db), actor, root)
}

/** Test-only SQLite binding for provider-neutral package preview. */
export function buildPackagePreview(
  db: ProviderNeutralDatabase,
  actor: PreviewParameters[1],
  pkg: PreviewParameters[2],
  options: PreviewParameters[3],
): ReturnType<typeof buildPackagePreviewFromReadPort> {
  return buildPackagePreviewFromReadPort(createResourcePackageReadPort(db), actor, pkg, options)
}

/** Test-only SQLite/filesystem binding for provider-neutral package export. */
export function exportResourcePackage(
  db: ProviderNeutralDatabase,
  actor: ExportParameters[2],
  root: ExportParameters[3],
  options: ExportParameters[4] & Readonly<{ appHome: string }>,
): ReturnType<typeof exportResourcePackageFromReadPort> {
  return exportResourcePackageFromReadPort(
    createResourcePackageReadPort(db),
    (skillId) => readPackageSkillTree(db, options.appHome, skillId),
    actor,
    root,
    options,
  )
}
