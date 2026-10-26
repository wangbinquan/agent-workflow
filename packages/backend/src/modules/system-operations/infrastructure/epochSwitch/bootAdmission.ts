import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { parseGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { parseDatabaseGenerationText } from '@/platform/persistence/generationValidation'
import { digestSchemaContract } from '@/platform/persistence/schema/canonical'
import { unpublishedSqliteInstallation } from '@/platform/persistence/unpublishedInstallation'
import { parseEpochSwitchJournal } from '../../domain/epochSwitch/model'
import {
  classifyEpochInstallation,
  epochInstallationGuidance,
} from '../../domain/epochSwitch/classification'

export {
  classifyEpochInstallation,
  epochInstallationGuidance,
} from '../../domain/epochSwitch/classification'
export function readEpochBootFacts(input: {
  appHome: string
  provider: DatabaseProvider
  externalSourceExists?: boolean
}) {
  const pointerPath = join(input.appHome, 'database-generation.json')
  const text = existsSync(pointerPath) ? readFileSync(pointerPath, 'utf8') : null
  const pointer =
    text === null
      ? null
      : (JSON.parse(text) as { payload?: { version?: number } }).payload?.version === 2
        ? parseGenerationPointerV2(text)
        : parseDatabaseGenerationText(text, pointerPath)
  const root = join(input.appHome, 'database-migrations')
  const paths = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name))
    : []
  const journals = paths
    .flatMap((path) =>
      existsSync(join(path, 'epoch-switch.json'))
        ? [parseEpochSwitchJournal(readFileSync(join(path, 'epoch-switch.json'), 'utf8'))]
        : [],
    )
    .sort((a, b) => b.payload.updatedAt - a.payload.updatedAt)
  const operation =
    journals.find((j) => !['completed', 'rolled-back', 'abandoned'].includes(j.payload.status)) ??
    journals.find((j) => j.payload.operationId === pointer?.payload.operationId) ??
    null
  const artifact = (name: string) =>
    operation ? join(root, operation.payload.operationId, name) : null
  const activation = artifact('activation-receipt.json')
  let activationReceiptDigest: string | null = null
  if (activation && existsSync(activation)) {
    const receipt = JSON.parse(readFileSync(activation, 'utf8')) as {
      payload: unknown
      digest: string
    }
    if (digestSchemaContract(receipt.payload) !== receipt.digest)
      throw new Error('epoch-activation-receipt-corrupt')
    activationReceiptDigest = receipt.digest
  }
  const retiredFile = artifact('rollback-retired.json')
  const retired =
    retiredFile && existsSync(retiredFile)
      ? (JSON.parse(readFileSync(retiredFile, 'utf8')) as { generationId: string })
      : null
  const rollbackIncomplete =
    retired !== null &&
    pointer !== null &&
    retired.generationId === pointer.payload.generationId &&
    operation?.payload.status !== 'rolled-back' &&
    operation?.payload.status !== 'abandoned'
  const rfc349Operation =
    paths.flatMap((path) => {
      if (!existsSync(join(path, 'manifest.json'))) return []
      const value = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as {
        payload: { phase: string; rolledBackAt: number | null; operationId: string }
        digest: string
      }
      if (digestSchemaContract(value.payload) !== value.digest)
        throw new Error('database-migration-manifest-corrupt')
      return value.payload.phase !== 'finalized' && value.payload.rolledBackAt === null
        ? [value.payload.operationId]
        : []
    })[0] ?? null
  let sourceExists = input.externalSourceExists ?? false
  const unpublished = !pointer
    ? unpublishedSqliteInstallation(input.appHome, {
        classificationOnly: true,
        excludedPaths: journals.flatMap(({ payload }) =>
          payload.target.location?.kind === 'sqlite-file'
            ? [join(input.appHome, payload.target.location.relativePath)]
            : [],
        ),
      })
    : null
  const file = join(input.appHome, 'db.sqlite')
  if (existsSync(file) && unpublished?.path !== file) {
    const db = new Database(file, { readonly: true })
    try {
      sourceExists =
        db
          .query(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
          )
          .get() !== null
    } finally {
      db.close()
    }
  }
  return {
    pointer,
    provider: pointer?.payload.provider ?? input.provider,
    sourceExists,
    operation,
    rfc349Operation,
    activationReceiptDigest,
    targetState: rollbackIncomplete ? ('retired' as const) : null,
    rollbackIncomplete,
  }
}
export function admitEpochBoot(input: Parameters<typeof readEpochBootFacts>[0]) {
  const state = classifyEpochInstallation(readEpochBootFacts(input))
  const guidance = epochInstallationGuidance(state)
  if (guidance) throw new Error(guidance)
  return state
}
