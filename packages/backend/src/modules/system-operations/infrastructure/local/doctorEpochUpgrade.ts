import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '@agent-workflow/shared'
import { epochSourceDiagnostics } from '@/platform/persistence/epochUpgradeDiagnostics'
import {
  readEpochBootFactsForConfig,
  classifyEpochInstallation,
  epochInstallationGuidance,
} from '../epochSwitch/bootAdmission'
import { autoUpgradeTrigger } from '../../domain/epochSwitch/autoUpgrade'
import { autoUpgradeRoot } from './autoUpgradeState'

/** Inspect old metadata without resolving it as an epoch-2 generation (which requires a pointer). */
export async function doctorEpochUpgrade(appHome: string, config: Config) {
  const facts = await readEpochBootFactsForConfig({
    appHome,
    database: config.database,
  })
  const installation = classifyEpochInstallation(facts)
  const latest = facts.autoUpgradeSessions?.at(-1)
  if (installation.kind === 'fresh' || (installation.kind === 'epoch2' && !latest?.unfinished))
    return null
  const trigger = autoUpgradeTrigger({
    facts,
    installation,
    standalone: true,
    enabled: config.autoEpochMigration !== false,
  })
  const lines = [
    `epoch-1 ${facts.provider} source`,
    trigger.kind === 'start' || trigger.kind === 'resume'
      ? 'The next start / migrate will automatically upgrade this installation.'
      : (trigger.guidance ??
        epochInstallationGuidance(installation, config.autoEpochMigration !== false) ??
        trigger.reason),
  ]
  if (latest)
    lines.push(
      `auto session ${latest.operationId}: ${latest.outcome ?? 'unfinished'}, phase ${facts.operation?.payload.phase ?? 'intent'}; ${JSON.stringify(latest.records.at(-1)?.data)}`,
    )
  lines.push(
    ...(await epochSourceDiagnostics({
      appHome,
      database: config.database,
      autoUpgradeRoot: autoUpgradeRoot(appHome),
      session: latest && {
        ...latest,
        currentRunId:
          facts.operation?.payload.operationId === latest.operationId
            ? (facts.operation.payload.run?.runId ?? null)
            : null,
      },
    })),
  )
  if (facts.rfc349Operation) {
    const manifest = JSON.parse(
      readFileSync(
        join(appHome, 'database-migrations', facts.rfc349Operation, 'manifest.json'),
        'utf8',
      ),
    ) as { payload: { phase: string } }
    lines.push(
      `RFC-349 ${facts.rfc349Operation}: ${manifest.payload.phase}; accepting-writes will be finalized automatically; other unfinished phases require the old binary.`,
    )
  }
  return { name: 'database provider', ok: trigger.kind !== 'refuse', message: lines.join('\n') }
}
