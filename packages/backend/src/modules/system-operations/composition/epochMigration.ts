// RFC-395: offline migration assembly surface. Runtime boot uses epochBootAdmission.
export { createEpochSwitchApplication } from '../application/epochSwitch/application'
export {
  epochRunArtifacts,
  relocateEpochPath,
  type EpochSwitchApplicationWithWithdrawal,
  type EpochSwitchDependencies,
} from '../application/epochSwitch/session'
export { createMigrationTraceQuery } from '../application/epochSwitch/trace'
export {
  EpochOperationIdSchema,
  EpochSwitchError,
  type EpochSwitchFaults,
  type EpochSwitchJournal,
} from '../domain/epochSwitch/model'
export { createFileEpochSwitchJournal } from '../infrastructure/epochSwitch/fileJournal'
export { pruneEpochPlanContent } from '../infrastructure/epochSwitch/planContent'
export { createEpochSourceAdapter } from '../infrastructure/epochSwitch/sourceAdapter'
export { createEpochBackupAdapter } from '../infrastructure/epochSwitch/backupAdapter'
export { createContentInventoryAdapter } from '../infrastructure/epochSwitch/contentInventoryAdapter'
export { createTargetGenerationPort } from '../infrastructure/epochSwitch/targetGeneration'
export { createDryRunSink } from '../infrastructure/epochSwitch/dryRunSink'
export { createPointerEpochActivation } from '../infrastructure/epochSwitch/pointerActivation'
export { createEpochSourceRetention } from '../infrastructure/epochSwitch/sourceRetention'
export { createEpochRestoreFiles } from '../infrastructure/epochSwitch/restoreFiles'
export { verifyDatabaseMigrationManifest } from '../domain/databaseMigration'
export {
  createEpochInstallationProbe,
  readEpochTargetEvidence,
} from '../infrastructure/epochSwitch/installationProbe'
export { createLocalEpochQuiesce } from '../infrastructure/local/epochSwitchQuiesce'
export { environmentProfile } from '../domain/epochSwitch/supportMatrix'
export { phaseIndex } from '../domain/epochSwitch/transitions'
export {
  createMetaEpochSwitchJournal,
  type HostedEpochArtifacts,
} from '../infrastructure/epochSwitch/metaJournal'
export {
  createHostedEpochActivation,
  type HostedEpochSwitchControl,
} from '../infrastructure/epochSwitch/hostedActivation'
export {
  createHostedEpochFreeze,
  type HostedFreezeAcknowledgement,
} from '../infrastructure/epochSwitch/hostedFreeze'
export { EPOCH2_META_TABLES } from '../infrastructure/persistence/migrationMetaTables'
export { settleEpochSwitchBeforePointerReplacement } from '../infrastructure/epochSwitch/pointerReplacement'
