import { createMigrationProgressReporter } from '@/platform/persistence/migration/run/progress'
import { writeSync } from 'node:fs'
import { createCrewStationObjectReader } from '@/platform/crewstation/objectStorage'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCrewStationPlatformApi } from '@/platform/crewstation/platformApi'
import { persistenceHead, persistencePostgresqlCatalogs } from './persistenceHead'
import {
  composeHostedEpochSwitch,
  type HostedEpochJobEntryDependencies,
} from './epochMigrationHosted'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'

/** U6 integration boundary. CrewStation supplies this versioned control URL;
 * ordinary hosted boot does not load this adapter or the converter. */
export function composeHostedEpochJobEntry(
  env: Readonly<Record<string, string | undefined>>,
): HostedEpochJobEntryDependencies {
  const url = env.CS_DATABASE_MIGRATION_CONTROL_URL
  if (!url)
    throw new Error(
      'CS_DATABASE_MIGRATION_CONTROL_URL is required; the CrewStation migration control adapter must be integrated before a hosted epoch switch',
    )
  const api = createCrewStationPlatformApi({ baseUrl: url })
  return {
    async compose(contract) {
      const path = `/v1/operations/${encodeURIComponent(contract.operationId)}`
      return composeHostedEpochSwitch(contract, {
        head: persistenceHead(),
        progress: createMigrationProgressReporter((line) => {
          writeSync(2, line)
        }),
        catalogArtifacts: persistencePostgresqlCatalogs(),
        sourceBornOnPostgresql: env.CS_DATABASE_MIGRATION_SOURCE_BORN_ON_POSTGRESQL === '1',
        objects: createCrewStationObjectReader({
          baseUrl: env.CS_PLATFORM_API_URL ?? url,
          token: env.CS_PLATFORM_API_TOKEN,
        }),
        artifacts: {
          async writeOnce(operationId, name, bytes) {
            const digest = bytesDigest(bytes)
            const receipt = await api.post<{ digest: string; bytes: number }>(`${path}/artifacts`, {
              operationId,
              name,
              digest,
              bytes: Buffer.from(bytes).toString('base64'),
              requestKey: `${operationId}:${name}:${digest}`,
            })
            if (receipt.digest !== digest || receipt.bytes !== bytes.byteLength)
              throw new Error('hosted-artifact-receipt-mismatch')
            return {
              path: `${path}/artifacts/${encodeURIComponent(name)}`,
              digest,
              bytes: receipt.bytes,
            }
          },
          async read(operationId, name) {
            const value = await api.get<{ bytes: string; digest: string } | null>(
              `${path}/artifacts`,
              { operationId, name },
            )
            if (!value) return null
            const bytes = Buffer.from(value.bytes, 'base64')
            if (bytesDigest(bytes) !== value.digest)
              throw new Error('hosted-artifact-content-mismatch')
            return bytes
          },
        },
        verifyFreeze: async (ack) =>
          (await api.post<{ verified: boolean }>(`${path}/freeze/verify`, ack)).verified,
        control: {
          async prepared(input) {
            await api.post(`${path}/prepared`, {
              ...input,
              requestKey: `${input.operationId}:${input.receiptDigest}`,
            })
          },
          observe: (operationId) => api.get(`${path}/activation`, { operationId }),
          async rollback() {
            await api.post(`${path}/rollback`, { requestKey: `${contract.operationId}:rollback` })
          },
        },
        async downloadBackup(reference, destination) {
          const artifact = await api.get<{ bytes: string; digest: string }>(`${path}/backup`, {
            reference,
          })
          const bytes = Buffer.from(artifact.bytes, 'base64')
          if (bytesDigest(bytes) !== artifact.digest)
            throw new Error('hosted-restore-artifact-mismatch')
          await mkdir(destination, { recursive: true })
          const file = join(destination, 'source-backup.tar.gz')
          await writeFile(file, bytes)
          return file
        },
      })
    },
  }
}
