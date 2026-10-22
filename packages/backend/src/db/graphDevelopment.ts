import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable as physicalTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { providerAwareSqliteTable } from './providerSchema'

const table = providerAwareSqliteTable(physicalTable)

// DA owns these records. Case / Task references are opaque, not cross-owner foreign keys.
export const developmentDesigns = table(
  'development_designs',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id').notNull(),
    revision: integer('revision').notNull(),
    presentationJson: text('presentation_json').notNull().default('{}'),
    presentationRevision: integer('presentation_revision').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('development_designs_case_uq').on(t.caseId),
    check(
      'development_designs_revision_ck',
      sql`${t.revision} > 0 AND ${t.presentationRevision} > 0`,
    ),
  ],
)

export const developmentDesignRevisions = table(
  'development_design_revisions',
  {
    designId: text('design_id').notNull(),
    revision: integer('revision').notNull(),
    artifactRef: text('artifact_ref').notNull(),
    digest: text('digest').notNull(),
    requestId: text('request_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.designId, t.revision] }),
    uniqueIndex('development_design_revisions_request_uq').on(t.designId, t.requestId),
    check('development_design_revisions_revision_ck', sql`${t.revision} > 0`),
  ],
)

// Proposals and command receipts share an identity ledger, never a separate execution queue.
export const developmentDesignProposals = table(
  'development_design_proposals',
  {
    designId: text('design_id').notNull(),
    id: text('id').notNull(),
    kind: text('kind').notNull(),
    requestDigest: text('request_digest').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.designId, t.id] }),
    index('development_design_proposals_status_idx').on(t.designId, t.kind, t.status),
    check('development_design_proposals_version_ck', sql`${t.version} > 0`),
  ],
)

export const developmentDesignBaselines = table(
  'development_design_baselines',
  {
    designId: text('design_id').notNull(),
    id: text('id').notNull(),
    digest: text('digest').notNull(),
    artifactRef: text('artifact_ref').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.designId, t.id] }),
    index('development_design_baselines_digest_idx').on(t.designId, t.digest),
  ],
)

export const developmentDesignLinks = table(
  'development_design_links',
  {
    designId: text('design_id').notNull(),
    id: text('id').notNull(),
    kind: text('kind').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.designId, t.id] }),
    index('development_design_links_kind_idx').on(t.designId, t.kind),
  ],
)
