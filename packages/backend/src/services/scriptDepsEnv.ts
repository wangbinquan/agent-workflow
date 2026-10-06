// RFC-370 compatibility address; cache, installer and error identity have one owner.
export {
  scriptEnvsRoot,
  ensureScriptDepsEnv,
  collectScriptDepsEnvs,
  ScriptDepsInstallError,
  type ScriptDepsEnv,
  type EnsureDepsInput,
} from '@/modules/task-execution/infrastructure/local/scriptDepsEnv'
