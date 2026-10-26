// RFC-395 II-b R2: generation layout and completed-time retention, not startup wiring.
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeGenerationPointerV2, type GenerationPointerV2Payload } from './generationPointerV2'

export function sqliteGenerationLayout(
  generationId: string,
  root = join(homedir(), '.agent-workflow'),
) {
  const relativePath = `databases/${generationId}/db.sqlite`
  const directory = join(root, 'databases', generationId)
  return {
    root,
    directory,
    relativePath,
    databasePath: join(directory, 'db.sqlite'),
    pointerPath: join(root, 'database-generation.json'),
  }
}
export function resolveSqliteGenerationDatabase(
  root: string,
  pointer: GenerationPointerV2Payload,
): string {
  if (pointer.provider !== 'sqlite' || pointer.database.kind !== 'sqlite-file')
    throw new Error('generation-is-not-sqlite')
  const layout = sqliteGenerationLayout(pointer.generationId, root)
  if (pointer.database.relativePath !== layout.relativePath)
    throw new Error('generation-sqlite-layout-mismatch')
  return layout.databasePath
}
export async function installSqliteGeneration(input: {
  readonly root: string
  readonly generationId: string
  readonly schemaEpoch: number
  readonly contractDigest: string
  readonly planDigest: string
  readonly activatedAt: number
  /** A supplies the completed target baseline installer. */
  readonly initialize: (databasePath: string) => void | Promise<void>
}) {
  const layout = sqliteGenerationLayout(input.generationId, input.root)
  mkdirSync(layout.directory, { recursive: true })
  await input.initialize(layout.databasePath)
  if (!existsSync(layout.databasePath)) throw new Error('generation-install-database-missing')
  const pointer = writeGenerationPointerV2({
    pointerPath: layout.pointerPath,
    payload: {
      version: 2,
      schemaEpoch: input.schemaEpoch,
      generationId: input.generationId,
      provider: 'sqlite',
      role: 'installed',
      database: { kind: 'sqlite-file', relativePath: layout.relativePath },
      contractDigest: input.contractDigest,
      planDigest: input.planDigest,
      operationId: null,
      manifestDigest: null,
      activatedAt: input.activatedAt,
      previous: null,
    },
  })
  return { ...layout, pointer }
}
/** All source handles must already be closed. rename preserves the source; EXDEV is not copied/deleted. */
export function retainCompletedSqliteSource(input: {
  readonly root: string
  readonly operationId: string
  readonly sourceDatabasePath: string
  readonly phase: string
}): readonly string[] {
  if (input.phase !== 'completed') throw new Error('source-retention-requires-completed')
  const destination = join(input.root, 'database-migrations', input.operationId, 'source')
  mkdirSync(destination, { recursive: true })
  return ['', '-wal', '-shm'].flatMap((suffix) => {
    const source = `${input.sourceDatabasePath}${suffix}`
    const target = join(destination, `db.sqlite${suffix}`)
    if (existsSync(source)) {
      if (existsSync(target)) throw new Error(`source-retention-destination-exists: ${target}`)
      renameSync(source, target)
    }
    return existsSync(target) ? [target] : []
  })
}
