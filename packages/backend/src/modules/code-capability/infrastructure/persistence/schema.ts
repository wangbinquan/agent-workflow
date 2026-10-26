// RFC-395 activation: this context declares the live epoch-2 schema directly.
import {
  column as c,
  defineContribution,
  retention,
  raw,
  index,
} from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'

const owner = defineContribution('code-capability')

const capabilityTemplatesDefinition = owner.table({
  id: 'capability_templates',
  schemaSymbol: 'capabilityTemplates',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    description: c.text('description', { nullable: true }),
    capability: c.text('capability'),
    scriptsJson: c.jsonText('scripts_json', { default: '{}' }),
    hooksJson: c.jsonText('hooks_json', { default: '[]' }),
    paramSchemaJson: c.jsonText('param_schema_json', { default: '[]' }),
    paramDefaultsJson: c.jsonText('param_defaults_json', { default: '{}' }),
    agentBySlotJson: c.jsonText('agent_by_slot_json', { default: '{}' }),
    promptBySlotJson: c.jsonText('prompt_by_slot_json', { default: '{}' }),
    paramsJson: c.jsonText('params_json', { default: '{}' }),
    stageContractVer: c.int('stage_contract_ver', { default: 1 }),
    upstreamId: c.id('upstream_id', { nullable: true }),
    upstreamVersion: c.int('upstream_version', { nullable: true }),
    baseDigest: c.id('base_digest', { nullable: true }),
    baseSnapshotJson: c.jsonText('base_snapshot_json', { nullable: true }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    visibility: c.enum('visibility', ['public', 'private'], { default: 'public' }),
    aclRevision: c.int('acl_revision', { default: 0 }),
    builtin: c.bool('builtin', { default: false }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'capability_templates_visibility_enum',
      expression: raw(
        '"capability_templates"."visibility" IN (\'public\',\'private\')',
        "\"visibility\" IN ('public','private')",
      ),
    },
  ],
  indexes: [
    index('capability_templates_owner_name_unique', ['owner_user_id', 'name'], { unique: true }),
    index('idx_capability_templates_capability', ['capability']),
    index('idx_capability_templates_upstream', ['upstream_id']),
  ],
  retention: retention.business,
})

export const capabilityTemplates = materializeDrizzle(capabilityTemplatesDefinition).table

const repoCapabilityConfigDefinition = owner.table({
  id: 'repo_capability_config',
  schemaSymbol: 'repoCapabilityConfig',
  columns: {
    id: c.id('id', { primary: true }),
    repoId: c.id('repo_id'),
    capability: c.text('capability'),
    templateId: c.id('template_id', { nullable: true }),
    enabled: c.bool('enabled', { default: false }),
    triggerConfigJson: c.jsonText('trigger_config_json', { default: '{}' }),
    readiness: c.enum('readiness', ['disabled', 'misconfigured', 'ready'], { default: 'disabled' }),
    readinessIssuesJson: c.jsonText('readiness_issues_json', { default: '[]' }),
    dependencyRevision: c.int('dependency_revision', { default: 0 }),
    lastValidatedAt: c.epochMs('last_validated_at', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'repo_capability_config_enabled_boolean',
      expression: raw('"repo_capability_config"."enabled" IN (0, 1)', '"enabled" IN (FALSE, TRUE)'),
    },
    {
      name: 'repo_capability_config_readiness_enum',
      expression: raw(
        "\"repo_capability_config\".\"readiness\" IN ('disabled','misconfigured','ready')",
        "\"readiness\" IN ('disabled','misconfigured','ready')",
      ),
    },
  ],
  indexes: [
    index('uniq_repo_capability_cell', ['repo_id', 'capability'], { unique: true }),
    index('idx_repo_capability_template', ['template_id']),
    index('idx_repo_capability_readiness', ['readiness']),
  ],
  retention: retention.business,
})

export const repoCapabilityConfig = materializeDrizzle(repoCapabilityConfigDefinition).table

export const schemaContribution = {
  owner: 'code-capability',
  version: 1,
  tables: [capabilityTemplatesDefinition, repoCapabilityConfigDefinition],
} as const

const historyOwner = defineContribution('code-capability/history')

const codeHistoryArchivesDefinition = historyOwner.table({
  version: 1,
  unique: [
    {
      name: 'code_history_archives_source',
      columns: ['source_generation', 'source_contract', 'source_table'],
      nulls: 'distinct',
    },
  ],
  foreignKeys: [],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'code_history_archives',
  schemaSymbol: 'codeHistoryArchives',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    id: c.id('id', { primary: true }),
    formatVersion: c.int('format_version'),
    sourceContract: c.text('source_contract'),
    sourceGeneration: c.id('source_generation'),
    sourceTable: c.text('source_table'),
    rowCount: c.int('row_count'),
    rootDigest: c.text('root_digest'),
    createdAt: c.epochMs('created_at'),
    contentRefJson: c.jsonText('content_ref_json', {
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'content_inline_bytes' },
    }),
    contentInlineBytes: c.bytes('content_inline_bytes', { nullable: true }),
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
})

export const codeHistoryArchives = materializeDrizzle(codeHistoryArchivesDefinition).table

const codeHistoryIdIndexDefinition = historyOwner.table({
  version: 1,
  unique: [],
  foreignKeys: [
    {
      name: 'code_history_id_index_archive_fk',
      columns: ['archive_id'],
      foreignTable: 'code_history_archives',
      foreignColumns: ['id'],
      onDelete: 'no action',
      onUpdate: 'no action',
      lifecycle: 'The package remains addressable while any original-ID lookup refers to it.',
    },
  ],
  checks: [],
  indexes: [
    {
      name: 'code_history_id_index_archive',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'archive_id' },
        { kind: 'column', name: 'record_ordinal' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'code_history_id_index',
  schemaSymbol: 'codeHistoryIdIndex',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    sourceTable: c.text('source_table'),
    originalId: c.id('original_id'),
    sourceContract: c.text('source_contract'),
    archiveId: c.id('archive_id'),
    originalKeyJson: c.jsonText('original_key_json'),
    recordOrdinal: c.int('record_ordinal'),
  },
  primaryKey: ['source_table', 'original_id', 'source_contract'],
  migrationKey: ['source_table', 'original_id', 'source_contract'],
})

export const codeHistoryIdIndex = materializeDrizzle(codeHistoryIdIndexDefinition).table

export const historySchemaContribution = {
  owner: 'code-capability/history',
  version: 1,
  tables: [codeHistoryArchivesDefinition, codeHistoryIdIndexDefinition],
} as const
