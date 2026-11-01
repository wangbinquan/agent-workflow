export {
  readEpochBootFacts,
  readEpochBootFactsForConfig,
  admitEpochBoot,
} from '../infrastructure/epochSwitch/bootAdmission'
export {
  classifyEpochInstallation,
  epochInstallationGuidance,
} from '../domain/epochSwitch/classification'

// RFC-398 design §1 / §2.1: boot-only pure policy, without converter reachability.
export { autoUpgradeTrigger } from '../domain/epochSwitch/autoUpgrade'
