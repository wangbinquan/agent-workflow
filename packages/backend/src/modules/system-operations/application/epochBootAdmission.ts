// RFC-532 — a standalone daemon's boot admission of its local epoch installation (until RFC-532 the daemon's start ran
// this itself when the deployment had no database installation): the automatic upgrade first, then a staged pending
// restore. The decisions are this module's epoch policy (domain); the composition hands in the effects — reading the
// installation facts, the upgrade child, re-reading the configuration, the pending restore and the upgrade log.
import type { DatabaseConfig } from '@agent-workflow/shared'
import type { Logger } from '@/platform/logging/logger'
import { autoUpgradeTrigger } from '../domain/epochSwitch/autoUpgrade'
import {
  classifyEpochInstallation,
  epochInstallationGuidance,
  type InstallationFacts,
} from '../domain/epochSwitch/classification'

export interface EpochBootConfiguration {
  readonly database: DatabaseConfig
  readonly autoEpochMigration?: boolean
}

export interface LocalEpochBootAdmissionEffects {
  /** The installation facts for the configured database. */
  readFacts(database: DatabaseConfig): Promise<InstallationFacts>
  /** The automatic upgrade (the standalone profile runs this binary's CLI in a child). */
  runAutoUpgrade(): Promise<void>
  /** Re-read after the upgrade, which may rewrite the database settings. */
  readConfiguration(): EpochBootConfiguration | Promise<EpochBootConfiguration>
  /** Apply a staged pending restore, once the installation is classified as servable. */
  applyPendingRestore(): Promise<unknown>
  /** The log the completed upgrade's receipt and restrictions go to. */
  upgradeLog(): Pick<Logger, 'info' | 'warn'>
}

/** Bring the local installation to one this release can serve, or throw the operator's guidance. */
export async function admitLocalEpochInstallation(
  effects: LocalEpochBootAdmissionEffects,
  config: EpochBootConfiguration,
): Promise<void> {
  let current = config
  let facts = await effects.readFacts(current.database)
  let installation = classifyEpochInstallation(facts)
  const trigger = autoUpgradeTrigger({
    facts,
    installation,
    standalone: true,
    enabled: current.autoEpochMigration !== false,
  })
  if (trigger.kind === 'refuse') throw new Error(trigger.guidance ?? trigger.reason)
  if (trigger.kind === 'start' || trigger.kind === 'resume') {
    await effects.runAutoUpgrade()
    current = await effects.readConfiguration()
    facts = await effects.readFacts(current.database)
    installation = classifyEpochInstallation(facts)
    if (
      installation.kind !== 'epoch2' ||
      (facts.autoUpgradeSessions ?? []).some((s) => s.unfinished)
    )
      throw new Error(
        'Automatic upgrade exited without a verified epoch-2 installation and completed session. Run agent-workflow db migration status.',
      )
  }
  const latest = facts.autoUpgradeSessions?.at(-1)
  if (latest?.outcome === 'completed') {
    const receipt = latest.records.at(-1)?.data.receipt as Record<string, unknown> | undefined
    if (receipt) {
      const upgradeLog = effects.upgradeLog()
      upgradeLog.info('automatic upgrade receipt', receipt)
      if (Array.isArray(receipt.restrictions))
        for (const restriction of receipt.restrictions)
          upgradeLog.warn(`restriction: ${JSON.stringify(restriction)}`)
    }
  }
  const guidance = epochInstallationGuidance(installation, current.autoEpochMigration !== false)
  if (guidance !== null) throw new Error(guidance)
  // Classify legacy and unreconciled installations before resolving a pending restore.
  await effects.applyPendingRestore()
}
