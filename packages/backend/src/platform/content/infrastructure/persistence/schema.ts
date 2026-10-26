// RFC-395 activation: this context declares the live epoch-2 schema directly.
import { column as c, defineContribution } from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'

const owner = defineContribution('platform/content')

const contentObjectsDefinition = owner.table({
  version: 1,
  unique: [],
  foreignKeys: [],
  checks: [
    {
      name: 'content_objects_size_nonnegative',
      expression: {
        kind: 'binary',
        op: '>=',
        left: { kind: 'column', name: 'size' },
        right: { kind: 'literal', value: 0 },
      },
    },
  ],
  indexes: [
    {
      name: 'content_objects_sha256',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'sha256' }],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'content_objects',
  schemaSymbol: 'contentObjects',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    contentId: c.id('content_id', { primary: true }),
    contentVersion: c.int('content_version'),
    sha256: c.text('sha256'),
    size: c.int('size'),
    mediaType: c.text('media_type', { nullable: true }),
    kind: c.enum('kind', ['local-file', 'database-bytes', 'object']),
    locationJson: c.jsonText('location_json'),
    createdAt: c.epochMs('created_at'),
  },
  primaryKey: ['content_id'],
  migrationKey: ['content_id'],
})

export const contentObjects = materializeDrizzle(contentObjectsDefinition).table

const contentBytesDefinition = owner.table({
  version: 1,
  unique: [],
  foreignKeys: [
    {
      name: 'content_bytes_object_fk',
      columns: ['content_id'],
      foreignTable: 'content_objects',
      foreignColumns: ['content_id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Catalog object owns database bytes; domain references own the object lifetime.',
    },
  ],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'content_bytes',
  schemaSymbol: 'contentBytes',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    contentId: c.id('content_id', { primary: true }),
    bytes: c.bytes('bytes'),
  },
  primaryKey: ['content_id'],
  migrationKey: ['content_id'],
})

export const contentBytes = materializeDrizzle(contentBytesDefinition).table

const contentPublicationsDefinition = owner.table({
  version: 1,
  unique: [],
  foreignKeys: [
    {
      name: 'content_publications_object_fk',
      columns: ['content_id'],
      foreignTable: 'content_objects',
      foreignColumns: ['content_id'],
      onDelete: 'no action',
      onUpdate: 'no action',
      lifecycle:
        'Publication ledger retains object metadata throughout release retries and retained history.',
    },
  ],
  checks: [
    {
      name: 'content_publications_shape_known',
      expression: {
        kind: 'binary',
        op: 'OR',
        left: {
          kind: 'binary',
          op: 'AND',
          left: {
            kind: 'binary',
            op: '=',
            left: { kind: 'column', name: 'state' },
            right: { kind: 'literal', value: 'pending' },
          },
          right: { kind: 'unary', op: 'IS NULL', value: { kind: 'column', name: 'released_at' } },
        },
        right: {
          kind: 'binary',
          op: 'OR',
          left: {
            kind: 'binary',
            op: 'AND',
            left: {
              kind: 'binary',
              op: '=',
              left: { kind: 'column', name: 'state' },
              right: { kind: 'literal', value: 'ready' },
            },
            right: {
              kind: 'binary',
              op: 'AND',
              left: {
                kind: 'unary',
                op: 'IS NOT NULL',
                value: { kind: 'column', name: 'content_id' },
              },
              right: {
                kind: 'binary',
                op: 'AND',
                left: {
                  kind: 'unary',
                  op: 'IS NULL',
                  value: { kind: 'column', name: 'released_at' },
                },
                right: {
                  kind: 'unary',
                  op: 'IS NULL',
                  value: { kind: 'column', name: 'source_sealed' },
                },
              },
            },
          },
          right: {
            kind: 'binary',
            op: 'AND',
            left: {
              kind: 'in',
              value: { kind: 'column', name: 'state' },
              values: [
                { kind: 'literal', value: 'releasing' },
                { kind: 'literal', value: 'released' },
              ],
            },
            right: {
              kind: 'binary',
              op: 'AND',
              left: {
                kind: 'unary',
                op: 'IS NOT NULL',
                value: { kind: 'column', name: 'released_at' },
              },
              right: {
                kind: 'unary',
                op: 'IS NULL',
                value: { kind: 'column', name: 'source_sealed' },
              },
            },
          },
        },
      },
    },
    {
      name: 'content_publications_size_valid',
      expression: {
        kind: 'binary',
        op: '>=',
        left: { kind: 'column', name: 'size' },
        right: { kind: 'literal', value: 0 },
      },
    },
  ],
  indexes: [
    {
      name: 'content_publications_identity',
      unique: true,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'owner' },
        { kind: 'column', name: 'logical_key' },
      ],
      where: null,
    },
    {
      name: 'content_publications_work_idx',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'state' },
        { kind: 'column', name: 'next_attempt_at' },
      ],
      where: null,
    },
    {
      name: 'content_publications_scope_idx',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'owner' },
        { kind: 'column', name: 'scope' },
        { kind: 'column', name: 'state' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'content_publications',
  schemaSymbol: 'contentPublications',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    id: c.id('id', { primary: true }),
    owner: c.text('owner'),
    logicalKey: c.id('logical_key'),
    scope: c.text('scope', { nullable: true }),
    attempt: c.text('attempt'),
    state: c.enum('state', ['pending', 'ready', 'releasing', 'released']),
    sha256: c.text('sha256'),
    size: c.int('size'),
    epoch: c.int('epoch'),
    sourceSealed: c.text('source_sealed', { nullable: true }),
    attempts: c.int('attempts', { default: 0 }),
    nextAttemptAt: c.epochMs('next_attempt_at', { default: 0 }),
    createdAt: c.epochMs('created_at'),
    releasedAt: c.epochMs('released_at', { nullable: true }),
    updatedAt: c.epochMs('updated_at'),
    contentId: c.id('content_id', { nullable: true }),
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
})

export const contentPublications = materializeDrizzle(contentPublicationsDefinition).table

export const schemaContribution = {
  owner: 'platform/content',
  version: 1,
  tables: [contentObjectsDefinition, contentBytesDefinition, contentPublicationsDefinition],
} as const
