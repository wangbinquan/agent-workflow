import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from '@/util/hash'
import type { AutoUpgradeRecordPort } from '../../application/ports/epochSwitch'
import {
  foldAutoUpgradeSession,
  type AutoUpgradeAcceptanceEvidence,
} from '../../domain/epochSwitch/autoUpgrade'
import { EpochOperationIdSchema } from '../../domain/epochSwitch/model'
import { autoUpgradeRoot, readAutoUpgradeSessions } from '../local/autoUpgradeState'
import { writeEpochFile } from './fileJournal'

export function createAutoUpgradeRecords(appHome: string): AutoUpgradeRecordPort {
  const root = autoUpgradeRoot(appHome)
  const sessionRoot = (id: string) => join(root, 'sessions', EpochOperationIdSchema.parse(id))
  return {
    async list() {
      return readAutoUpgradeSessions(appHome)
    },
    async append(operationId, kind, data) {
      const prior =
        readAutoUpgradeSessions(appHome).find((s) => s.operationId === operationId)?.records ?? []
      const record = {
        version: 1 as const,
        operationId,
        sequence: prior.length + 1,
        kind,
        at: Date.now(),
        data,
      }
      foldAutoUpgradeSession([...prior, record])
      writeEpochFile(
        join(sessionRoot(operationId), `${String(record.sequence).padStart(4, '0')}-${kind}.json`),
        Buffer.from(JSON.stringify(record)),
        true,
      )
      return record
    },
    async receipt(operationId, value) {
      const path = join(sessionRoot(operationId), 'receipt.json')
      // Recovery after receipt publication uses its original timings/bytes.
      if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      writeEpochFile(path, Buffer.from(JSON.stringify(value)), true)
      return value
    },
    async acceptance(operationId, runId) {
      const operationRoot = join(
        appHome,
        'database-migrations',
        EpochOperationIdSchema.parse(operationId),
      )
      const root = join(operationRoot, '.artifacts')
      const evidence: AutoUpgradeAcceptanceEvidence[] = []
      const read = (directory: string, digest?: string) => {
        if (!existsSync(directory)) return
        for (const name of readdirSync(directory).filter((n) =>
          /^acceptance-health-\d+\.json$/.test(n),
        )) {
          const bytes = readFileSync(join(directory, name))
          if (digest && sha256Hex(bytes) !== digest)
            throw new Error('auto-upgrade-acceptance-digest-mismatch')
          const value = JSON.parse(
            bytes.toString('utf8'),
          ) as AutoUpgradeAcceptanceEvidence['health'] & { runId?: string }
          // Keep RFC-395's strict HealthReport bytes (also consumed by rollback). Acceptance
          // only runs after activation, after which new-run is forbidden: an untagged
          // operation-root acceptance report necessarily belongs to its current run.
          evidence.push({ runId: value.runId ?? runId, published: true, name, health: value })
        }
      }
      read(operationRoot)
      if (existsSync(root))
        for (const digest of readdirSync(root).filter((d) => /^[a-f0-9]{64}$/.test(d))) {
          read(join(root, digest))
          read(join(root, digest, 'runs', runId))
        }
      return evidence
    },
  }
}
