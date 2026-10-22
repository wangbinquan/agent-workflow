// RFC-370 v3 V5 — CS RFC-042 restore and verify Jobs. `agent-workflow migrate`
// restores when the platform supplies CS_DATABASE_RESTORE_REFERENCE; the
// database URL already names the empty platform-provisioned target. This file
// only assembles; restore, verification and normalization live in
// infrastructure and in each owner's participant (wired by bootstrap).
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import { createCrewStationObjectReader } from '@/platform/crewstation/objectStorage'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { hostedDatabaseGeneration } from '@/platform/persistence/generationValidation'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import type { HostedRestoreNormalizationParticipant } from '../infrastructure/crewstation/restoreNormalizationContract'
import { parseHostedBackupReference } from '../infrastructure/crewstation/databaseBackupFormat'
import { restoreHostedDatabaseInstallation } from '../infrastructure/crewstation/databaseRestoreInstallation'
import { verifyHostedDatabaseRestore } from '../infrastructure/crewstation/databaseRestoreVerification'
import { sha256Hex } from '@/util/hash'

export const HOSTED_RESTORE_REFERENCE_ENV = 'CS_DATABASE_RESTORE_REFERENCE'

interface RestoreEnvironmentInput {
  readonly contract: LogicalSchemaContract
  readonly environment: { readonly project: string; readonly service: string }
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Release-Job input. Without a restore reference this is an ordinary migrate. */
export async function restoreCrewStationDatabaseFromEnvironment(
  input: RestoreEnvironmentInput & {
    /** Owner participants, composed by bootstrap (`composeCrewStationRestoreNormalization`). */
    readonly normalization?: readonly HostedRestoreNormalizationParticipant[]
  },
): Promise<void> {
  const prepared = prepareRestore(input)
  if (!prepared) return
  try {
    if (input.normalization === undefined) throw new Error('hosted-restore-normalization-unwired')
    const history = await loadPostgresqlMigrationHistory({ headContract: input.contract })
    await restoreHostedDatabaseInstallation({
      headContract: input.contract,
      ...prepared,
      plan: history.head.plan,
      normalization: input.normalization,
    })
  } finally {
    await prepared.runtime.close()
  }
}

function prepareRestore(input: RestoreEnvironmentInput) {
  const reference = input.env[HOSTED_RESTORE_REFERENCE_ENV]?.trim()
  if (!reference) return null
  if (
    !input.env.CS_DATABASE_GENERATION_ID ||
    input.env.CS_DATABASE_GENERATION_OPERATION !== input.env.CS_DATABASE_RESTORE_OPERATION ||
    !input.env.CS_OBJECTS_TOKEN
  )
    throw new Error('hosted-restore-platform-identity-missing')
  parseHostedBackupReference(reference)
  const baseUrl = input.env.CS_OBJECTS_URL?.trim() ?? ''
  const objectSpaceId = input.env.CS_OBJECT_SPACE_ID?.trim() ?? ''
  const key = Buffer.from(input.env.AW_SECRET_KEY ?? '', 'base64')
  if (!URL.canParse(baseUrl) || !/^[a-f0-9-]{36}$/.test(objectSpaceId) || key.length !== 32)
    throw new Error('hosted-restore-requires-object-space-and-original-secret-key')
  const contract = input.contract
  const generation = hostedDatabaseGeneration({
    ...input.environment,
    schemaDigest: contract.digest,
    env: input.env,
  }).payload
  if (generation.operationId === null)
    throw new Error('hosted-restore-generation-operation-missing')
  const runtime = createPostgresqlDatabaseRuntime({
    config: PostgresqlDatabaseConfigSchema.parse({
      provider: 'postgresql',
      urlEnv: 'CS_DATABASE_URL',
      poolMax: 2,
    }),
    generationId: generation.generationId,
    env: input.env,
  })
  return {
    runtime,
    reference,
    contract,
    generation: { generationId: generation.generationId, operationId: generation.operationId },
    installation: `${input.environment.project}/${input.environment.service}`,
    objectSpaceId,
    keyFingerprint: sha256Hex(key),
    objects: createCrewStationObjectReader({ baseUrl, token: input.env.CS_OBJECTS_TOKEN }),
  }
}

export async function verifyCrewStationDatabaseRestore(input: RestoreEnvironmentInput) {
  const prepared = prepareRestore(input)
  if (!prepared) throw new Error('hosted-restore-reference-missing')
  try {
    return await verifyHostedDatabaseRestore(prepared)
  } finally {
    await prepared.runtime.close()
  }
}
