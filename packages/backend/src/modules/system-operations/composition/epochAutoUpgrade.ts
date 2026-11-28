// RFC-626 §3.5: assembly surface for the environment check of the automatic upgrade.
// The automatic composition root reads the home configuration before it can assemble
// anything else, so the judgement and its refusal are offered here next to the adapter.
export {
  createAutoUpgradeEnvironment,
  readHomeConfigFile,
} from '../infrastructure/local/autoUpgradeEnvironment'
export {
  checkHomeConfig,
  environmentRefusalConclusion,
  homeConfigRefusal,
  lockOutOfSpaceRefusal,
  unloadableConfigRefusal,
} from '../domain/epochSwitch/environmentPrecheck'
