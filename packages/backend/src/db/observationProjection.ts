import {
  index,
  integer,
  primaryKey,
  sqliteTable as physicalTable,
  text,
} from 'drizzle-orm/sqlite-core'
import { providerAwareSqliteTable } from './providerSchema'

const table = providerAwareSqliteTable(physicalTable)
/** Derived projection writes are deliberately outside the original source
 * revision roster. They cannot enqueue their own source changes. */
export const observationProjectionHeads = table('observation_projection_heads', {
  id: text('id').primaryKey(),
  revision: text('revision').notNull(),
  asOf: integer('as_of').notNull(),
})
export const observationProjectionVersions = table('observation_projection_versions', {
  revision: text('revision').primaryKey(),
  asOf: integer('as_of').notNull(),
  bootstrapComplete: integer('bootstrap_complete', { mode: 'boolean' }).notNull().default(false),
})
export const observationProjectionWork = table(
  'observation_projection_work',
  {
    id: text('id').primaryKey(),
    document: text('document').notNull(),
    fingerprint: text('fingerprint').notNull(),
    completedRevision: text('completed_revision'),
    prepared: text('prepared'),
    leaseToken: text('lease_token'),
    leaseUntil: integer('lease_until').notNull().default(0),
    retryAt: integer('retry_at').notNull().default(0),
    failure: text('failure'),
    appliedRevision: text('applied_revision'),
    retryCount: integer('retry_count').notNull().default(0),
  },
  (t) => [
    index('observation_projection_work_pending').on(
      t.completedRevision,
      t.retryAt,
      t.leaseUntil,
      t.id,
    ),
    index('observation_projection_work_unapplied').on(t.appliedRevision, t.id),
  ],
)
export const observationProjectionWorkComponents = table(
  'observation_projection_work_components',
  {
    workId: text('work_id')
      .notNull()
      .references(() => observationProjectionWork.id),
    component: text('component').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workId, t.component] })],
)
export const observationProjectionCurrent = table(
  'observation_projection_current',
  {
    kind: text('kind').$type<'contribution' | 'aggregate'>().notNull(),
    key: text('key').notNull(),
    component: text('component'),
    revision: text('revision').notNull(),
    document: text('document').notNull(),
    section: text('section'),
    originalKey: text('original_key'),
    parent: text('parent'),
    taskId: text('task_id'),
    cohortAt: integer('cohort_at'),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.key] }),
    index('observation_projection_current_component').on(t.kind, t.component, t.key),
  ],
)
export const observationProjectionHistory = table(
  'observation_projection_history',
  {
    kind: text('kind').$type<'contribution' | 'aggregate'>().notNull(),
    key: text('key').notNull(),
    component: text('component'),
    fromRevision: text('from_revision').notNull(),
    toRevision: text('to_revision'),
    document: text('document').notNull(),
    section: text('section'),
    originalKey: text('original_key'),
    parent: text('parent'),
    taskId: text('task_id'),
    cohortAt: integer('cohort_at'),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.key, t.fromRevision] }),
    index('observation_projection_history_component').on(t.kind, t.component, t.key),
    index('observation_projection_history_section').on(t.kind, t.section, t.cohortAt, t.key),
    index('observation_projection_history_task').on(t.kind, t.taskId, t.section, t.parent, t.key),
    index('observation_projection_history_day').on(t.kind, t.section, t.taskId, t.cohortAt, t.key),
    index('observation_projection_history_scope_day').on(
      t.kind,
      t.section,
      t.component,
      t.cohortAt,
      t.key,
    ),
  ],
)
export const observationProjectionMemberships = table(
  'observation_projection_memberships',
  {
    aggregate: text('aggregate').notNull(),
    key: text('key').notNull(),
    fromRevision: text('from_revision').notNull(),
    toRevision: text('to_revision'),
  },
  (t) => [
    primaryKey({ columns: [t.aggregate, t.key, t.fromRevision] }),
    index('observation_projection_memberships_key').on(t.key, t.fromRevision),
  ],
)
/** Row changes are captured in the original producer transaction, including
 * deletes. This queue has no high-water cursor that can skip a late commit. */
export const observationProjectionChanges = table(
  'observation_projection_changes',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    entityKey: text('entity_key').notNull(),
    operation: text('operation').notNull(),
    previousRoute: text('previous_route'),
    nextRoute: text('next_route'),
    createdAt: integer('created_at').notNull(),
    completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
    retryAt: integer('retry_at').notNull().default(0),
  },
  (t) => [
    index('observation_projection_changes_pending').on(t.completed, t.createdAt, t.id),
    index('observation_projection_changes_ready').on(t.completed, t.retryAt, t.createdAt, t.id),
  ],
)
/** Reverse scope index makes a changed/deleted fact select its previously
 * affected component even after the original parent relation disappears. */
export const observationProjectionDependencies = table(
  'observation_projection_dependencies',
  {
    source: text('source').notNull(),
    entityKey: text('entity_key').notNull(),
    component: text('component').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.entityKey, t.component] }),
    index('observation_projection_dependencies_component').on(t.component),
  ],
)
/** Staged qualified rows are written before the short publication transaction;
 * native/file reads never hold the original SQLite writer lease. */
export const observationProjectionPrepared = table(
  'observation_projection_prepared',
  {
    workId: text('work_id')
      .notNull()
      .references(() => observationProjectionWork.id),
    key: text('key').notNull(),
    document: text('document').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workId, t.key] })],
)
/** A query stores only its scope and projection version, never a copied set of
 * raw facts or another calculation for each seven/thirty day period. */
export const observationProjectionViews = table('observation_projection_views', {
  id: text('id').primaryKey(),
  actorScope: text('actor_scope').notNull(),
  document: text('document').notNull(),
})
/** Index accepted platform/native identities to their qualified components.
 * Platform task IDs are never confused with AW Task IDs. These rows are derived
 * and are replaced in the same transaction as their original contribution. */
export const observationProjectionBindings = table(
  'observation_projection_bindings',
  {
    kind: text('kind').notNull(),
    identity: text('identity').notNull(),
    contributionKey: text('contribution_key').notNull(),
    component: text('component').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.identity, t.contributionKey] }),
    index('observation_projection_binding_component').on(t.component),
    index('observation_projection_binding_contribution').on(t.contributionKey),
  ],
)
/** Initial enumeration checkpoints survive a daemon restart. Producer outbox
 * rows cover commits concurrent with this scan; a cursor is never used as a
 * committed producer high-water mark. */
export const observationProjectionBootstrap = table(
  'observation_projection_bootstrap',
  {
    generation: text('generation').notNull(),
    channel: text('channel').notNull(),
    cursor: text('cursor'),
    done: integer('done', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.generation, t.channel] })],
)
export const observationProjectionComponents = table('observation_projection_components', {
  component: text('component').primaryKey(),
  revision: text('revision').notNull(),
})
