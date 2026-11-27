// RFC-624: one authoritative migration table for original guards and the shared scan.
// Tuples retain the original destination/export/import contracts; old paths are derived once.

export const RFC571_MOVED: ReadonlyArray<
  readonly [string, string, readonly string[], readonly string[]]
> = [
  ['util/semver', 'platform/contracts/semver', ['compareSemver', 'extractVersion'], []],
  ['util/time', 'platform/contracts/monotonicNow', ['monotonicNow'], []],
  ['util/keyedSerialQueue', 'platform/contracts/keyedSerialQueue', ['KeyedSerialQueue'], []],
  [
    'util/jsonDocument',
    'platform/http/jsonDocument',
    ['JsonDocument', 'jsonDocumentResponse', 'parseJsonDocument'],
    [],
  ],
  [
    'util/zodJsonSchema',
    'platform/operations/zodJsonSchema',
    ['toInputJsonSchema', 'withInputJsonSchema'],
    ['zod'],
  ],
  [
    'util/frontmatter',
    'platform/content/frontmatter',
    ['FrontmatterDoc', 'parseFrontmatter', 'stringifyFrontmatter'],
    ['yaml'],
  ],
  ['util/zip', 'platform/content/zip', ['ZipFile', 'encodeZip'], ['fflate']],
  ['util/version', 'platform/execution/version', ['BUILD_VERSION', 'appVersion'], []],
  // The RFC-571 follow-up: the two leaves left behind at first.
  [
    'util/inFlight',
    'platform/contracts/inFlight',
    ['InFlightCoalescer', 'createInFlightCoalescer'],
    [],
  ],
  ['util/sqlChunk', 'platform/persistence/sqlChunk', ['SQL_IN_CHUNK', 'chunkedAll'], []],
]

export const RFC571_RULE = {
  id: 'RFC-571',
  sourceFile: 'packages/backend/tests/rfc571-util-primitives-into-platform-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到旧路径',
  moved: RFC571_MOVED,
  oldPaths: RFC571_MOVED.map(([old]) => old),
} as const

export const RFC572_MOVED: ReadonlyArray<
  readonly [string, string, readonly string[], readonly string[]]
> = [
  [
    'util/platformExec',
    'platform/execution/local/platformExec',
    [
      'EXECUTABLE_SUFFIX_FOR_HOST',
      'GIT_NULL_CONFIG_PATH',
      'NULL_DEVICE_FOR_HOST',
      'SEALED_SHELL_SUPPORTED',
      'buildControlledPath',
      'buildControlledPathForHost',
      'buildScriptPath',
      'controlledSystemPathEntries',
      'disabledShellCommand',
      'disabledShellCommandForHost',
      'executableSuffix',
      'isLexicallyInside',
      'isLexicallyInsideForHost',
      'nullDevice',
      'pathListJoin',
      'pathListJoinForHost',
      'pathListSplit',
      'pathListSplitForHost',
      'platformHomeEnv',
      'platformHomeEnvForHost',
      'platformSpawnOptions',
      'platformSpawnOptionsForHost',
      'resolveGitToolDirectory',
      'toPortableRelativePath',
    ],
    ['node:path'],
  ],
  [
    'util/windowsJobObject',
    'platform/execution/local/windowsJobObject',
    [
      'ProcessTreeOwnership',
      'WIN32_JOB_LAYOUT',
      'adoptProcessTree',
      'processTreeOwnershipAvailable',
      'processTreeOwnershipDiagnosis',
      'resetKernel32CacheForTests',
    ],
    ['bun:ffi'],
  ],
  [
    'util/process',
    'platform/execution/local/process',
    [
      'DEFAULT_VERSION_PROBE_TIMEOUT_MS',
      'KillTreeSignal',
      'ProcessLivenessOptions',
      'STALE_RUN_PID_MAX_AGE_MS',
      'STALE_RUN_QUIESCE_BUDGET_MS',
      'StaleRunKillOpts',
      'StaleRunKillOutcome',
      'TREE_QUIESCE_BUDGET_MS',
      'TreeQuiesceLog',
      'TreeQuiesceOutcome',
      'VersionProbeOpts',
      'VersionProbeResult',
      'adoptSpawnedProcessTree',
      'awaitProcessTreeQuiesced',
      'detachedProcessGroup',
      'isProcessAlive',
      'isProcessTreeAlive',
      'killProcessTree',
      'killStaleRunProcessTree',
      'pidCommandContainsBinary',
      'pidCommandContainsLaunchIdentity',
      'pidCommandLooksLikeAgentChild',
      'processTreeOwnershipStatus',
      'raceWithFallback',
      'readStreamCapped',
      'reapDetachedGroup',
      'releaseProcessTreeOwnership',
      'spawnVersionProbe',
    ],
    [
      '@/platform/execution/local/platformExec',
      '@/platform/execution/local/windowsJobObject',
      '@/platform/logging/logger',
    ],
  ],
  [
    'util/lock',
    'platform/execution/local/daemonLock',
    // RFC-625 adds the shared owner snapshot/token API while retaining every original lock export.
    // Its only new dependencies are the sibling Windows identity adapter and node's UUID primitive.
    [
      'DaemonLockHeldError',
      'DaemonLockOwner',
      'Lock',
      'acquireLock',
      'adoptCurrentProcessLock',
      'createCurrentProcessLockOwner',
      'isDaemonLockOwnerAlive',
      'isProcessAlive',
      'parseDaemonLockOwner',
      'readDaemonLockOwner',
      'readLivePidFromLock',
      'readPidFromLock',
      'sameDaemonLockOwner',
      'serializeDaemonLockOwner',
      'writePidFileForTest',
    ],
    ['./process', './windowsProcessIdentity', 'node:crypto', 'node:fs', 'node:path'],
  ],
  [
    'util/spawnDiagnostics',
    'platform/execution/local/spawnDiagnostics',
    ['SpawnEnoentContext', 'SpawnEnoentProbes', 'explainSpawnEnoent', 'outputTail'],
    ['node:fs', 'node:path'],
  ],
  [
    'util/archive',
    'platform/persistence/archive',
    ['extractTarGz', 'resetTarProbeForTests', 'tarAvailable', 'tarBin', 'tarGz'],
    ['@/platform/execution/local/platformExec', 'node:fs', 'node:path'],
  ],
]

export const RFC572_RULE = {
  id: 'RFC-572',
  sourceFile: 'packages/backend/tests/rfc572-util-process-family-into-platform-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到旧路径',
  moved: RFC572_MOVED,
  oldPaths: RFC572_MOVED.map(([old]) => old),
} as const

export const RFC573_MOVED: ReadonlyArray<
  readonly [string, string, readonly string[], readonly string[]]
> = [
  [
    'util/timeoutSignal',
    'platform/contracts/timeoutSignal',
    ['TimeoutSignal', 'timeoutSignal'],
    [],
  ],
  [
    'util/fsReclaim',
    'platform/workspace/local/fsReclaim',
    ['DEFAULT_RECLAIM_DELAYS_MS', 'RemoveDirectoryWithRetryResult', 'removeDirectoryWithRetry'],
    ['@/platform/logging/logger', 'node:fs', 'node:fs/promises'],
  ],
  [
    'util/migrationsFolder',
    'platform/persistence/migration/migrationsFolder',
    ['ResolveMigrationsOptions', 'resolveMigrationsFolder', 'resolvePostgresqlMigrationsFolder'],
    ['@/embed', '@/platform/configuration/installationPaths', 'node:fs', 'node:path'],
  ],
]

export const RFC573_DAEMON_INFO = 'util/daemonInfo'

export const RFC573_RULE = {
  id: 'RFC-573',
  sourceFile: 'packages/backend/tests/rfc573-util-small-files-placement-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到旧路径',
  moved: RFC573_MOVED,
  oldPaths: [...RFC573_MOVED.map(([old]) => old), RFC573_DAEMON_INFO],
} as const

export const RFC574_MOVED: ReadonlyArray<
  readonly [string, string, readonly string[], readonly string[]]
> = [
  [
    'util/paths',
    'platform/configuration/installationPaths',
    ['Paths', 'appHome'],
    ['node:os', 'node:path'],
  ],
  [
    'util/http',
    'platform/http/requestParsing',
    ['parseBoolQuery', 'safeJsonOrEmpty', 'safeJsonOrThrowInvalid'],
    ['@/platform/errors/domainErrors', 'hono'],
  ],
]

export const RFC574_RULE = {
  id: 'RFC-574',
  sourceFile: 'packages/backend/tests/rfc574-util-paths-and-http-into-platform-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到旧路径',
  moved: RFC574_MOVED,
  oldPaths: RFC574_MOVED.map(([old]) => old),
} as const

export const RFC575_MOVED: ReadonlyArray<
  readonly [string, string, readonly string[], readonly string[]]
> = [
  [
    'util/errors',
    'platform/errors/domainErrors',
    [
      'ConflictError',
      'DomainError',
      'ErrorPayload',
      'ForbiddenError',
      'GoneError',
      'NotFoundError',
      'SkillQuarantinedError',
      'UnauthorizedError',
      'ValidationError',
      'diagnosticTextOf',
      'errorHandler',
      'staleConflictError',
    ],
    ['../logging/logger', 'drizzle-orm', 'hono', 'hono/utils/http-status'],
  ],
  [
    'util/hash',
    'platform/contracts/hash',
    ['Sha256DigestBuilder', 'createSha256DigestBuilder', 'sha1Hex', 'sha256Hex'],
    ['node:crypto'],
  ],
  [
    'util/log',
    'platform/logging/logger',
    [
      'LogLevel',
      'Logger',
      'configureLogger',
      'createLogger',
      'resetLoggerForTest',
      'setLoggerStdoutWriterForTest',
    ],
    ['node:fs', 'node:path'],
  ],
]

export const RFC575_RULE = {
  id: 'RFC-575',
  sourceFile: 'packages/backend/tests/rfc575-util-errors-hash-log-into-platform-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到旧路径',
  moved: RFC575_MOVED,
  oldPaths: RFC575_MOVED.map(([old]) => old),
} as const

export const RFC576_MOVED: ReadonlyArray<readonly [string, string, string]> = [
  ['routes/backup', `modules/system-operations/inbound/http/backupRoutes`, 'mountBackupRoutes'],
  ['routes/restore', `modules/system-operations/inbound/http/restoreRoutes`, 'mountRestoreRoutes'],
  [
    'routes/databaseMigrations',
    `modules/system-operations/inbound/http/databaseMigrationRoutes`,
    'mountDatabaseMigrationRoutes',
  ],
  [
    'routes/overview',
    `modules/system-operations/inbound/http/overviewRoutes`,
    'mountOverviewRoutes',
  ],
  ['routes/daemon', `modules/system-operations/inbound/http/daemonRoutes`, 'mountDaemonRoutes'],
  [
    'routes/maintenance',
    `modules/system-operations/inbound/http/maintenanceRoutes`,
    'mountMaintenanceRoutes',
  ],
  [
    'routes/maintenanceDisk',
    `modules/system-operations/inbound/http/maintenanceDiskRoutes`,
    'mountMaintenanceDiskRoutes',
  ],
]

export const RFC576_RULE = {
  id: 'RFC-576',
  sourceFile:
    'packages/backend/tests/rfc576-system-operations-routes-into-inbound-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到旧路径',
  moved: RFC576_MOVED,
  oldPaths: RFC576_MOVED.map(([old]) => old),
} as const

export const RFC577_MOVED: ReadonlyArray<
  readonly [string, string, string, string, string, string]
> = [
  [
    'routes/executionContracts',
    'modules/execution-contract/inbound/http/executionContractRoutes',
    'execution-contract',
    'mountExecutionContractRoutes',
    'modules/execution-contract/public/types',
    'parseExecutionContractRef',
  ],
  [
    'routes/codeHosts',
    'modules/integration/inbound/http/codeHostRoutes',
    'integration',
    'mountCodeHostRoutes',
    'modules/integration/public/types',
    'CodeHostConnectionAdministration',
  ],
]

export const RFC577_RULE = {
  id: 'RFC-577',
  sourceFile: 'packages/backend/tests/rfc577-single-route-families-into-inbound-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到旧路径',
  moved: RFC577_MOVED,
  oldPaths: RFC577_MOVED.map(([old]) => old),
} as const

export const RFC578_MOVED: ReadonlyArray<
  readonly [string, string, string, string, readonly string[]]
> = [
  [
    'routes/memories',
    'modules/memory/inbound/http/memoryRoutes',
    'memory',
    'mountMemoryRoutes',
    ['@/modules/identity-access/public/participants', '@/modules/resource-catalog/public/types'],
  ],
  [
    'routes/memoryDistillJobs',
    'modules/memory/inbound/http/memoryDistillJobRoutes',
    'memory',
    'mountMemoryDistillJobRoutes',
    [],
  ],
  [
    'routes/repos',
    'modules/source-control/inbound/http/repoRoutes',
    'source-control',
    'mountRepoRoutes',
    [],
  ],
  [
    'routes/repoGroups',
    'modules/source-control/inbound/http/repoGroupRoutes',
    'source-control',
    'mountRepoGroupRoutes',
    [],
  ],
  [
    'routes/cached-repos',
    'modules/source-control/inbound/http/cachedRepoRoutes',
    'source-control',
    'mountCachedRepoRoutes',
    [],
  ],
]

export const RFC578_RULE = {
  id: 'RFC-578',
  sourceFile:
    'packages/backend/tests/rfc578-memory-source-control-routes-into-inbound-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到旧路径',
  moved: RFC578_MOVED,
  oldPaths: RFC578_MOVED.map(([old]) => old),
} as const

export const RFC579_MOVED: ReadonlyArray<
  readonly [string, string, string, string, readonly string[]]
> = [
  [
    'routes/clarify',
    'modules/collaboration/inbound/http/clarifyRoutes',
    'collaboration',
    'mountClarifyRoutes',
    [],
  ],
  [
    'routes/reviews',
    'modules/collaboration/inbound/http/reviewRoutes',
    'collaboration',
    'mountReviewRoutes',
    [],
  ],
  [
    'routes/taskClarifyDirective',
    'modules/collaboration/inbound/http/taskClarifyDirectiveRoutes',
    'collaboration',
    'mountTaskClarifyDirectiveRoutes',
    ['@/modules/task-execution/public/types'],
  ],
  [
    'routes/taskQuestions',
    'modules/collaboration/inbound/http/taskQuestionRoutes',
    'collaboration',
    'mountTaskQuestionRoutes',
    [],
  ],
  [
    'routes/developmentConfig',
    'modules/development-automation/inbound/http/developmentConfigRoutes',
    'development-automation',
    'mountDevelopmentConfigRoutes',
    ['@/modules/identity-access/public/participants'],
  ],
  [
    'routes/developmentMissions',
    'modules/development-automation/inbound/http/developmentMissionRoutes',
    'development-automation',
    'mountDevelopmentMissionRoutes',
    ['@/modules/identity-access/public/participants'],
  ],
  [
    'routes/missionInputUploads',
    'modules/development-automation/inbound/http/missionInputUploadRoutes',
    'development-automation',
    'mountMissionInputUploadRoutes',
    [],
  ],
]

export const RFC579_RULE = {
  id: 'RFC-579',
  sourceFile:
    'packages/backend/tests/rfc579-collaboration-development-automation-routes-into-inbound-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到旧路径',
  moved: RFC579_MOVED,
  oldPaths: RFC579_MOVED.map(([old]) => old),
} as const

export const RFC580_MOVED: ReadonlyArray<
  readonly [string, string, string, string, readonly string[]]
> = [
  [
    'routes/workflows',
    'modules/resource-catalog/inbound/http/workflowRoutes',
    'resource-catalog',
    'mountWorkflowRoutes',
    [],
  ],
  [
    'routes/workgroupTasks',
    'modules/resource-catalog/inbound/http/workgroupTaskRoutes',
    'resource-catalog',
    'mountWorkgroupTaskRoutes',
    [],
  ],
  [
    'routes/resourcePackages',
    'modules/resource-catalog/inbound/http/resourcePackageRoutes',
    'resource-catalog',
    'registerResourcePackageRoutes',
    ['@/modules/identity-access/public/participants'],
  ],
]

export const RFC580_RULE = {
  id: 'RFC-580',
  sourceFile:
    'packages/backend/tests/rfc580-resource-catalog-workflow-workgroup-routes-into-inbound-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到旧路径',
  moved: RFC580_MOVED,
  oldPaths: RFC580_MOVED.map(([old]) => old),
} as const

export const RFC581_MOVED: ReadonlyArray<
  readonly [string, string, string, string, readonly string[]]
> = [
  [
    'routes/mcps',
    'modules/resource-catalog/inbound/http/mcpRoutes',
    'resource-catalog',
    'mountMcpRoutes',
    ['@/modules/identity-access/public/participants'],
  ],
  [
    'routes/skills',
    'modules/resource-catalog/inbound/http/skillRoutes',
    'resource-catalog',
    'mountSkillRoutes',
    [],
  ],
  [
    'routes/plugins',
    'modules/resource-catalog/inbound/http/pluginRoutes',
    'resource-catalog',
    'mountPluginRoutes',
    [],
  ],
]

export const RFC581_RULE = {
  id: 'RFC-581',
  sourceFile:
    'packages/backend/tests/rfc581-resource-catalog-mcp-skill-plugin-routes-into-inbound-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到旧路径',
  moved: RFC581_MOVED,
  oldPaths: RFC581_MOVED.map(([old]) => old),
} as const

export const RFC582_MOVED: ReadonlyArray<
  readonly [string, string, string, string, readonly string[]]
> = [
  [
    'routes/port-artifacts',
    'modules/task-execution/inbound/http/portArtifactRoutes',
    'task-execution',
    'mountPortArtifactRoutes',
    [],
  ],
  [
    'routes/worktree-files',
    'modules/task-execution/inbound/http/worktreeFilesRoutes',
    'task-execution',
    'mountWorktreeFilesRoutes',
    ['@/modules/source-control/public/types'],
  ],
]

export const RFC582_RULE = {
  id: 'RFC-582',
  sourceFile:
    'packages/backend/tests/rfc582-task-execution-port-artifact-worktree-file-routes-into-inbound-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到旧路径',
  moved: RFC582_MOVED,
  oldPaths: RFC582_MOVED.map(([old]) => old),
} as const

export const RFC583_MOVED: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ['routes/config', `modules/system-operations/inbound/http/configRoutes`, ['mountConfigRoutes']],
  [
    'routes/docs',
    `modules/system-operations/inbound/http/docsRoutes`,
    ['mountDocsRoutes', 'mountWellKnownRoutes'],
  ],
  [
    'routes/plantuml',
    `modules/system-operations/inbound/http/plantumlRoutes`,
    ['mountPlantumlRoutes'],
  ],
  ['routes/publicOrigin', 'platform/http/publicOrigin', ['derivePublicOrigin', 'publicOriginOf']],
  ['routes/verifiedBodyLimit', 'platform/http/verifiedBodyLimit', ['verifiedBodyLimit']],
]

export const RFC583_RULE = {
  id: 'RFC-583',
  sourceFile:
    'packages/backend/tests/rfc583-system-operations-config-docs-plantuml-routes-and-http-helpers-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到旧路径',
  moved: RFC583_MOVED,
  oldPaths: RFC583_MOVED.map(([old]) => old),
} as const

export const RFC587_MOVED: ReadonlyArray<readonly [string, string, string, string, string]> = [
  [
    'routes/health',
    'modules/system-operations/inbound/http/healthRoutes',
    'system-operations',
    'mountHealthRoutes',
    '@/modules/system-operations/composition/routes',
  ],
  [
    'routes/taskArchive',
    'modules/task-execution/inbound/http/taskArchiveRoutes',
    'task-execution',
    'mountTaskArchiveRoutes',
    '@/modules/task-execution/composition',
  ],
  [
    'routes/taskFeedback',
    'modules/collaboration/inbound/http/taskFeedbackRoutes',
    'collaboration',
    'mountTaskFeedbackRoutes',
    '@/modules/collaboration/composition',
  ],
]

export const RFC587_RULE = {
  id: 'RFC-587',
  sourceFile:
    'packages/backend/tests/rfc587-health-archive-feedback-routes-into-owner-modules-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到旧路径',
  moved: RFC587_MOVED,
  oldPaths: RFC587_MOVED.map(([old]) => old),
} as const

export const RFC589_RULE = {
  id: 'RFC-589',
  sourceFile:
    'packages/backend/tests/rfc589-agent-workgroup-routes-split-by-owner-boundary.test.ts',
  title: 'src / tests / scripts 的全部说明符不再解析到两个旧路径',
  oldPaths: ['routes/agents', 'routes/workgroups'],
} as const

export const MIGRATION_REFERENCE_RULES = [
  RFC571_RULE,
  RFC572_RULE,
  RFC573_RULE,
  RFC574_RULE,
  RFC575_RULE,
  RFC576_RULE,
  RFC577_RULE,
  RFC578_RULE,
  RFC579_RULE,
  RFC580_RULE,
  RFC581_RULE,
  RFC582_RULE,
  RFC583_RULE,
  RFC587_RULE,
  RFC589_RULE,
] as const

export const RFC575_UTIL_REMAINDER: string[] = [
  // RFC-593: git.ts moved into source-control's local infrastructure.
  // RFC-617: fileTrust, win32Acl, gitHardening, gitRef, redact and safePath moved into platform.
  // RFC-619: the git credential lease and its helper entry moved into platform/execution/local, the OIDC failure page next
  // to its route in routes/.
]
