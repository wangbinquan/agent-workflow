// Compatibility exports; local storage effects live in the selected file adapter.
export {
  createFileResourcePackageSkillArtifactOwner as createPostgresqlResourcePackageSkillArtifactOwner,
  createFileResourcePackagePluginArtifactOwner as createPostgresqlResourcePackagePluginArtifactOwner,
  type FileResourcePackagePluginInstaller as PostgresqlResourcePackagePluginInstaller,
  type FileResourcePackagePluginInstallResult as PostgresqlResourcePackagePluginInstallResult,
} from './local/fileResourcePackageArtifacts'
