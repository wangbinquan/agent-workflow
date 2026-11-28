export {
  conversion,
  runtimeConfigEnvironment,
  // RFC-626 §3.5: the environment check before an automatic upgrade judges config.json alike.
  judgeRuntimeConfigFile,
} from '../infrastructure/migration/runtimeConfigRule'
export type { RuntimeConfigFileJudgement } from '../infrastructure/migration/runtimeConfigRule'
