// RFC-532 — the deployment's database installation, as the daemon's boot asks it (RFC-294 design §9.3): before the
// daemon opens its secret box, bring the installation to one this release can serve (`admit`); then prepare the
// selected database (`prepare`). The standalone profile hands over the local installation — the epoch path the daemon
// used to run itself when the deployment had no installation; the hosted profile hands over the release's
// installation port, which the release Job already installed.
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { createLogger } from '@/platform/logging/logger'
import { applyLocalEpoch2PendingRestore } from '../composition'
import {
  admitLocalEpochInstallation,
  type EpochBootConfiguration,
} from '../application/epochBootAdmission'
import type { SchemaHistoryRuntime } from '@/platform/persistence/schema/history/runtime'
import { readEpochBootFactsForConfig } from './epochBootAdmission'
import {
  prepareDaemonDatabaseProviderForBoot,
  type DaemonDatabaseBootPreparation,
  type DaemonDatabaseInstallationPort,
  type PreparedDaemonDatabase,
} from './daemonDatabase'

export interface DaemonDatabaseAdmissionInput {
  /** The configuration the daemon has read at this point of its boot. */
  readonly config: EpochBootConfiguration
  /** Re-read after an automatic upgrade, which may rewrite the database settings. */
  readonly configuration: { read(): EpochBootConfiguration | Promise<EpochBootConfiguration> }
  readonly contract: LogicalSchemaContract
  /** RFC-549: the binary's schema history (a staged restore is applied against it). */
  readonly schemaHistory: SchemaHistoryRuntime
}

export interface DaemonDatabaseInstallation {
  /** Before the daemon opens its secret box: bring the installation to one this release can serve. */
  admit(input: DaemonDatabaseAdmissionInput): Promise<void>
  /** Prepare the selected database for the daemon's boot. */
  prepare(input: DaemonDatabaseBootPreparation): Promise<PreparedDaemonDatabase>
}

/**
 * Standalone: the local epoch installation path (application `admitLocalEpochInstallation`: the automatic upgrade first,
 * in a child the profile hands over — it runs this binary's CLI — then a staged pending restore) and the local file
 * preparation. Assembly only: the decisions live in the application.
 */
export function composeLocalDaemonDatabaseInstallation(input: {
  readonly appHome: string
  readonly runAutoUpgrade: () => Promise<void>
}): DaemonDatabaseInstallation {
  return Object.freeze({
    admit: ({ config, configuration, contract, schemaHistory }: DaemonDatabaseAdmissionInput) =>
      admitLocalEpochInstallation(
        {
          readFacts: (database) =>
            readEpochBootFactsForConfig({ appHome: input.appHome, database }),
          runAutoUpgrade: input.runAutoUpgrade,
          readConfiguration: () => configuration.read(),
          applyPendingRestore: () => applyLocalEpoch2PendingRestore(contract, schemaHistory),
          upgradeLog: () => createLogger('epoch-upgrade'),
        },
        config,
      ),
    prepare: (preparation: DaemonDatabaseBootPreparation) =>
      prepareDaemonDatabaseProviderForBoot({
        kind: 'file' as const,
        configuration: preparation.configuration,
        file: preparation.file,
      }),
  })
}

/** Hosted: the release Job installed the database, so there is nothing to admit; preparation reads its installation port. */
export function composeSelectedDaemonDatabaseInstallation(
  installation: DaemonDatabaseInstallationPort,
): DaemonDatabaseInstallation {
  return Object.freeze({
    admit: async (): Promise<void> => undefined,
    prepare: (preparation: DaemonDatabaseBootPreparation) =>
      prepareDaemonDatabaseProviderForBoot({
        kind: 'selected' as const,
        configuration: preparation.configuration,
        installation,
        file: preparation.file,
      }),
  })
}
