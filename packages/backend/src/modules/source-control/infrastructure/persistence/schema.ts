// RFC-395 activation: this context declares the live epoch-2 schema directly.
import {
  column as c,
  defineContribution,
  retention,
  raw,
  foreignKey,
  index,
} from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'

const owner = defineContribution('source-control')

const cachedReposDefinition = owner.table({
  id: 'cached_repos',
  schemaSymbol: 'cachedRepos',
  columns: {
    id: c.id('id', { primary: true }),
    urlHash: c.text('url_hash', { unique: 'cached_repos_url_hash_unique' }),
    urlEnc: c.text('url_enc', { nullable: true }),
    urlRedacted: c.text('url_redacted', { nullable: true }),
    localPath: c.text('local_path'),
    defaultBranch: c.text('default_branch', { nullable: true }),
    lastFetchedAt: c.epochMs('last_fetched_at'),
    createdAt: c.epochMs('created_at'),
    hasSubmodules: c.bool('has_submodules', { nullable: true }),
    lastSubmoduleSyncOk: c.bool('last_submodule_sync_ok', { nullable: true }),
    lastSubmoduleSyncError: c.text('last_submodule_sync_error', { nullable: true }),
    lastAutoRefreshAt: c.epochMs('last_auto_refresh_at', { nullable: true }),
  },
  indexes: [
    index('idx_cached_repos_fetched_id', ['last_fetched_at', 'id']),
    index('idx_cached_repos_submodule_health', ['has_submodules', 'last_submodule_sync_ok']),
  ],
  retention: retention.business,
})

export const cachedRepos = materializeDrizzle(cachedReposDefinition).table

const hostedTaskWorkspacesDefinition = owner.table({
  id: 'hosted_task_workspaces',
  schemaSymbol: 'hostedTaskWorkspaces',
  columns: {
    taskId: c.id('task_id', { primary: true }),
    requestKey: c.id('request_key'),
    businessTaskId: c.id('business_task_id', { nullable: true }),
    state: c.enum('state', ['creating', 'ready', 'closing', 'closed']),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'hosted_task_workspaces_state_known',
      expression: raw(
        "\"hosted_task_workspaces\".\"state\" IN ('creating', 'ready', 'closing', 'closed')",
        "\"state\" IN ('creating', 'ready', 'closing', 'closed')",
      ),
    },
  ],
  indexes: [
    index('hosted_task_workspaces_business_task_unique', ['business_task_id'], { unique: true }),
  ],
  retention: retention.business,
})

export const hostedTaskWorkspaces = materializeDrizzle(hostedTaskWorkspacesDefinition).table

const hostedWorkspaceCommandsDefinition = owner.table({
  id: 'hosted_workspace_commands',
  schemaSymbol: 'hostedWorkspaceCommands',
  columns: {
    executionId: c.id('execution_id', { primary: true }),
    taskId: c.id('task_id'),
    businessTaskId: c.id('business_task_id'),
    operation: c.text('operation'),
    requestKey: c.id('request_key'),
    requestJson: c.jsonText('request_json'),
    subtaskId: c.id('subtask_id', { nullable: true }),
    attempt: c.int('attempt', { nullable: true }),
    lastCursor: c.text('last_cursor', { nullable: true }),
    outcomeJson: c.jsonText('outcome_json', { nullable: true }),
    state: c.enum('state', ['submitting', 'running', 'settled', 'abandoned']),
    epoch: c.int('epoch'),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'hosted_workspace_commands_state_known',
      expression: raw(
        "\"hosted_workspace_commands\".\"state\" IN ('submitting', 'running', 'settled', 'abandoned')",
        "\"state\" IN ('submitting', 'running', 'settled', 'abandoned')",
      ),
    },
  ],
  indexes: [
    index('idx_hosted_workspace_commands_state', ['state']),
    index('idx_hosted_workspace_commands_business_task', ['business_task_id', 'state']),
  ],
  retention: retention.business,
})

export const hostedWorkspaceCommands = materializeDrizzle(hostedWorkspaceCommandsDefinition).table

const repoGroupsDefinition = owner.table({
  id: 'repo_groups',
  schemaSymbol: 'repoGroups',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    description: c.text('description', { default: '' }),
    version: c.int('version', { default: 1 }),
    createdByUserId: c.id('created_by_user_id', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    schemaVersion: c.int('schema_version', { default: 1 }),
  },
  indexes: [
    index('idx_repo_groups_name_ci', [raw('lower("repo_groups"."name")', 'lower("name")')], {
      unique: true,
    }),
  ],
  retention: retention.business,
})

export const repoGroups = materializeDrizzle(repoGroupsDefinition).table

const repositoryTransportConnectionsDefinition = owner.table({
  id: 'repository_transport_connections',
  schemaSymbol: 'repositoryTransportConnections',
  columns: {
    provider: c.enum('provider', ['gitlab', 'github'], { primary: true }),
    connectionGeneration: c.text('connection_generation'),
    endpointBindingDigest: c.id('endpoint_binding_digest'),
    apiBaseUrl: c.text('api_base_url'),
    rejectUnauthorized: c.bool('reject_unauthorized'),
    transportMappingsJson: c.jsonText('transport_mappings_json'),
    allowedHttpBaseUrlsJson: c.jsonText('allowed_http_base_urls_json'),
    globalTokenEnc: c.text('global_token_enc'),
    globalTokenHint: c.text('global_token_hint'),
    credentialRevision: c.int('credential_revision', { default: 1 }),
    updatedAt: c.epochMs('updated_at'),
    updatedBy: c.text('updated_by', { nullable: true }),
  },
  checks: [
    {
      name: 'repository_transport_connections_generation_length',
      expression: raw(
        'length("repository_transport_connections"."connection_generation") BETWEEN 1 AND 128',
        'length("connection_generation") BETWEEN 1 AND 128',
      ),
    },
    {
      name: 'repository_transport_connections_provider_enum',
      expression: raw(
        '"repository_transport_connections"."provider" IN (\'gitlab\', \'github\')',
        "\"provider\" IN ('gitlab', 'github')",
      ),
    },
    {
      name: 'repository_transport_connections_endpoint_binding_digest_length',
      expression: raw(
        'length("repository_transport_connections"."endpoint_binding_digest") = 64 AND "repository_transport_connections"."endpoint_binding_digest" NOT GLOB \'*[^0-9a-f]*\'',
        'length("endpoint_binding_digest") = 64 AND "endpoint_binding_digest" !~ \'[^0-9a-f]\'',
      ),
    },
    {
      name: 'repository_transport_connections_reject_unauthorized_boolean',
      expression: raw(
        '"repository_transport_connections"."reject_unauthorized" IN (0, 1)',
        '"reject_unauthorized" IN (FALSE, TRUE)',
      ),
    },
    {
      name: 'repository_transport_connections_transport_mappings_json_json_valid',
      expression: raw(
        'json_valid("repository_transport_connections"."transport_mappings_json")',
        'json_valid("transport_mappings_json")',
      ),
    },
    {
      name: 'repository_transport_connections_allowed_http_base_urls_json_json_valid',
      expression: raw(
        'json_valid("repository_transport_connections"."allowed_http_base_urls_json")',
        'json_valid("allowed_http_base_urls_json")',
      ),
    },
    {
      name: 'repository_transport_connections_credential_revision_positive',
      expression: raw(
        '"repository_transport_connections"."credential_revision" > 0',
        '"credential_revision" > 0',
      ),
    },
  ],
  indexes: [
    index(
      'repository_transport_connections_provider_generation_uq',
      ['provider', 'connection_generation'],
      { unique: true },
    ),
  ],
  retention: retention.business,
})

export const repositoryTransportConnections = materializeDrizzle(
  repositoryTransportConnectionsDefinition,
).table

const scPreparationOperationsDefinition = owner.table({
  id: 'sc_preparation_operations',
  schemaSymbol: 'scPreparationOperations',
  columns: {
    id: c.id('id', { primary: true }),
    snapshotRef: c.id('snapshot_ref'),
    state: c.enum(
      'state',
      ['planned', 'resolving', 'materializing', 'prepared', 'failed', 'stopped', 'cleaned'],
      { default: 'planned' },
    ),
    version: c.int('version', { default: 0 }),
    resolvedJson: c.jsonText('resolved_json', { nullable: true }),
    receiptRef: c.id('receipt_ref', {
      nullable: true,
      unique: 'sc_preparation_operations_receipt_ref_unique',
    }),
    receiptJson: c.jsonText('receipt_json', { nullable: true }),
    failureCode: c.text('failure_code', { nullable: true }),
    diagnosticsJson: c.jsonText('diagnostics_json', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey(
      'sc_preparation_operations_snapshot_ref_sc_repository_snapshots_id_fk',
      ['snapshot_ref'],
      'sc_repository_snapshots',
      ['id'],
    ),
  ],
  retention: retention.operational,
})

export const scPreparationOperations = materializeDrizzle(scPreparationOperationsDefinition).table

const scRepositorySnapshotsDefinition = owner.table({
  id: 'sc_repository_snapshots',
  schemaSymbol: 'scRepositorySnapshots',
  columns: {
    id: c.id('id', { primary: true }),
    sourceRef: c.id('source_ref'),
    revision: c.text('revision'),
    factsJson: c.jsonText('facts_json'),
    createdAt: c.epochMs('created_at'),
  },
  foreignKeys: [
    foreignKey(
      'sc_repository_snapshots_source_ref_sc_repository_sources_id_fk',
      ['source_ref'],
      'sc_repository_sources',
      ['id'],
    ),
  ],
  retention: retention.business,
})

export const scRepositorySnapshots = materializeDrizzle(scRepositorySnapshotsDefinition).table

const scRepositorySourcesDefinition = owner.table({
  id: 'sc_repository_sources',
  schemaSymbol: 'scRepositorySources',
  columns: {
    id: c.id('id', { primary: true }),
    requestKey: c.id('request_key', { unique: 'sc_repository_sources_request_key_unique' }),
    requestDigest: c.id('request_digest'),
    kind: c.enum('kind', ['repository', 'repository-group', 'public-url']),
    factsJson: c.jsonText('facts_json'),
    createdAt: c.epochMs('created_at'),
  },
  retention: retention.business,
})

export const scRepositorySources = materializeDrizzle(scRepositorySourcesDefinition).table

const repoGroupNodesDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [
    {
      name: 'repo_group_nodes_group_id_repo_groups_id_fk',
      columns: ['group_id'],
      foreignTable: 'repo_groups',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
    {
      name: 'repo_group_nodes_cached_repo_id_cached_repos_id_fk',
      columns: ['cached_repo_id'],
      foreignTable: 'cached_repos',
      foreignColumns: ['id'],
      onDelete: 'no action',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 no action delete and no action update semantics; target is a logical table reference.',
    },
    {
      name: 'repo_group_nodes_child_group_fk',
      columns: ['child_group_id'],
      foreignTable: 'repo_groups',
      foreignColumns: ['id'],
      onDelete: 'no action',
      onUpdate: 'no action',
      lifecycle: 'The application must detach group references before deleting the group.',
    },
  ],
  checks: [
    {
      name: 'repo_group_nodes_attachment_kind_enum',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '"repo_group_nodes"."attachment_kind" IS NULL OR "repo_group_nodes"."attachment_kind" IN (\'repo\',\'group\')',
        postgresql: '"attachment_kind" IS NULL OR "attachment_kind" IN (\'repo\',\'group\')',
      },
    },
    {
      name: 'repo_group_nodes_attachment_kind_shape',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '("repo_group_nodes"."attachment_kind" IS NULL AND "repo_group_nodes"."cached_repo_id" IS NULL AND "repo_group_nodes"."child_group_id" IS NULL AND "repo_group_nodes"."ref" = \'\' AND "repo_group_nodes"."subdir" = \'\' AND "repo_group_nodes"."readonly" = 0) OR ("repo_group_nodes"."attachment_kind" = \'repo\' AND "repo_group_nodes"."cached_repo_id" IS NOT NULL AND "repo_group_nodes"."child_group_id" IS NULL) OR ("repo_group_nodes"."attachment_kind" = \'group\' AND "repo_group_nodes"."child_group_id" IS NOT NULL AND "repo_group_nodes"."cached_repo_id" IS NULL AND "repo_group_nodes"."ref" = \'\' AND "repo_group_nodes"."subdir" = \'\')',
        postgresql:
          '("attachment_kind" IS NULL AND "cached_repo_id" IS NULL AND "child_group_id" IS NULL AND "ref" = \'\' AND "subdir" = \'\' AND "readonly" = FALSE) OR ("attachment_kind" = \'repo\' AND "cached_repo_id" IS NOT NULL AND "child_group_id" IS NULL) OR ("attachment_kind" = \'group\' AND "child_group_id" IS NOT NULL AND "cached_repo_id" IS NULL AND "ref" = \'\' AND "subdir" = \'\')',
      },
    },
  ],
  indexes: [
    {
      name: 'idx_rgn_cached_repo',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'cached_repo_id' }],
      where: null,
    },
    {
      name: 'idx_rgn_child_group',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'child_group_id' }],
      where: null,
    },
    {
      name: 'idx_rgn_path_ci',
      unique: true,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'group_id' },
        {
          kind: 'raw',
          reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
          sqlite: 'lower("repo_group_nodes"."path")',
          postgresql: 'lower("path")',
        },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'repo_group_nodes',
  schemaSymbol: 'repoGroupNodes',
  columns: {
    groupId: c.id('group_id'),
    path: c.text('path'),
    attachmentKind: c.enum('attachment_kind', ['repo', 'group'], { nullable: true }),
    cachedRepoId: c.id('cached_repo_id', { nullable: true }),
    ref: c.text('ref', { default: '' }),
    subdir: c.text('subdir', { default: '' }),
    childGroupId: c.id('child_group_id', { nullable: true }),
    readonly: c.bool('readonly', { default: false }),
  },
  primaryKey: ['group_id', 'path'],
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  migrationKey: ['group_id', 'path'],
})

export const repoGroupNodes = materializeDrizzle(repoGroupNodesDefinition).table

export const schemaContribution = {
  owner: 'source-control',
  version: 2,
  columnUniqueNulls: [
    { table: 'sc_preparation_operations', column: 'receipt_ref', nulls: 'distinct' },
  ],
  tables: [
    cachedReposDefinition,
    hostedTaskWorkspacesDefinition,
    hostedWorkspaceCommandsDefinition,
    repoGroupsDefinition,
    repositoryTransportConnectionsDefinition,
    scPreparationOperationsDefinition,
    scRepositorySnapshotsDefinition,
    scRepositorySourcesDefinition,
    repoGroupNodesDefinition,
  ],
} as const
