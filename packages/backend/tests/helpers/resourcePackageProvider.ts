import type { DbClient } from '../../src/db/client'
import type { SecretBox } from '../../src/auth/secretBox'
import {
  composeResourcePackageOperations,
  composeSqliteResourcePackageProvider,
} from '../../src/modules/resource-catalog/composition/resourcePackageOperations'
import { createSqliteResourcePackageReadPort } from '../../src/modules/resource-catalog/infrastructure/sqlitePackageResourceRows'
import { readSqlitePackageSkillTree } from '../../src/modules/resource-catalog/infrastructure/sqlitePackageSkillTree'
import { createSqliteResourcePackageExecutionAdapter } from '../../src/services/resourcePackage/executionAdapter'
import { walkExportClosureFromReadPort } from '../../src/services/resourcePackage/closure'
import { exportResourcePackageFromReadPort } from '../../src/services/resourcePackage/export'
import { buildPackagePreviewFromReadPort } from '../../src/services/resourcePackage/preview'

type ClosureParameters = Parameters<typeof walkExportClosureFromReadPort>
type PreviewParameters = Parameters<typeof buildPackagePreviewFromReadPort>
type ExportParameters = Parameters<typeof exportResourcePackageFromReadPort>

export function composeSqliteResourcePackageCatalogForTest(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly box: SecretBox
}) {
  const provider = composeSqliteResourcePackageProvider({
    db: input.db,
    appHome: input.appHome,
  })
  return composeResourcePackageOperations({
    execution: createSqliteResourcePackageExecutionAdapter({
      db: input.db,
      appHome: input.appHome,
      box: input.box,
      provider,
    }),
    resources: provider.resources,
  })
}

/** Test-only SQLite binding for the provider-neutral package closure. */
export function walkExportClosure(
  db: DbClient,
  actor: ClosureParameters[1],
  root: ClosureParameters[2],
): ReturnType<typeof walkExportClosureFromReadPort> {
  return walkExportClosureFromReadPort(createSqliteResourcePackageReadPort(db), actor, root)
}

/** Test-only SQLite binding for provider-neutral package preview. */
export function buildPackagePreview(
  db: DbClient,
  actor: PreviewParameters[1],
  pkg: PreviewParameters[2],
  options: PreviewParameters[3],
): ReturnType<typeof buildPackagePreviewFromReadPort> {
  return buildPackagePreviewFromReadPort(
    createSqliteResourcePackageReadPort(db),
    actor,
    pkg,
    options,
  )
}

/** Test-only SQLite/filesystem binding for provider-neutral package export. */
export function exportResourcePackage(
  db: DbClient,
  actor: ExportParameters[2],
  root: ExportParameters[3],
  options: ExportParameters[4] & Readonly<{ appHome: string }>,
): ReturnType<typeof exportResourcePackageFromReadPort> {
  return exportResourcePackageFromReadPort(
    createSqliteResourcePackageReadPort(db),
    (skillId) => readSqlitePackageSkillTree(db, options.appHome, skillId),
    actor,
    root,
    options,
  )
}
