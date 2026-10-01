// Compatibility entry points; physical effects live in the selected local adapter.
export {
  createFileIntentSkillArtifactOwner as createPostgresqlIntentSkillArtifactLifecycle,
  createFileIntentPluginArtifactOwner as createPostgresqlIntentPluginArtifactLifecycle,
} from '../local/fileIntentApplyArtifactOwners'
