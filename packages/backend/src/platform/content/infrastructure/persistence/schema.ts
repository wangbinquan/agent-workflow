// RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.
import {
  column as c,
  defineContribution,
  retention,
  raw,
  index,
} from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'

const owner = defineContribution('platform/content')

const hostedObjectPublicationsDefinition = owner.table({
  id: 'hosted_object_publications',
  schemaSymbol: 'hostedObjectPublications',
  columns: {
    id: c.id('id', { primary: true }),
    owner: c.text('owner'),
    logicalKey: c.id('logical_key'),
    scope: c.text('scope', { nullable: true }),
    attempt: c.text('attempt'),
    state: c.enum('state', ['pending', 'ready', 'releasing', 'released']),
    sha256: c.text('sha256'),
    size: c.int('size'),
    objectId: c.id('object_id', { nullable: true }),
    epoch: c.int('epoch'),
    sourceSealed: c.text('source_sealed', { nullable: true }),
    attempts: c.int('attempts', { default: 0 }),
    nextAttemptAt: c.epochMs('next_attempt_at', { default: 0 }),
    createdAt: c.epochMs('created_at'),
    releasedAt: c.epochMs('released_at', { nullable: true }),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'hosted_object_publications_state_known',
      expression: raw(
        "\"hosted_object_publications\".\"state\" IN ('pending', 'ready', 'releasing', 'released')",
        "\"state\" IN ('pending', 'ready', 'releasing', 'released')",
      ),
    },
    {
      name: 'hosted_object_publications_shape_known',
      expression: raw(
        '("hosted_object_publications"."state" = \'pending\' AND "hosted_object_publications"."released_at" IS NULL) OR ("hosted_object_publications"."state" = \'ready\' AND "hosted_object_publications"."object_id" IS NOT NULL AND "hosted_object_publications"."released_at" IS NULL AND "hosted_object_publications"."source_sealed" IS NULL) OR ("hosted_object_publications"."state" IN (\'releasing\', \'released\') AND "hosted_object_publications"."released_at" IS NOT NULL AND "hosted_object_publications"."source_sealed" IS NULL)',
        '("state" = \'pending\' AND "released_at" IS NULL) OR ("state" = \'ready\' AND "object_id" IS NOT NULL AND "released_at" IS NULL AND "source_sealed" IS NULL) OR ("state" IN (\'releasing\', \'released\') AND "released_at" IS NOT NULL AND "source_sealed" IS NULL)',
      ),
    },
    {
      name: 'hosted_object_publications_size_valid',
      expression: raw('"hosted_object_publications"."size" >= 0', '"size" >= 0'),
    },
  ],
  indexes: [
    index('hosted_object_publications_identity', ['owner', 'logical_key'], { unique: true }),
    index('hosted_object_publications_work_idx', ['state', 'next_attempt_at']),
    index('hosted_object_publications_scope_idx', ['owner', 'scope', 'state']),
  ],
  retention: retention.business,
})

export const hostedObjectPublications = materializeDrizzle(hostedObjectPublicationsDefinition).table

export const schemaContribution = owner.contribution([hostedObjectPublicationsDefinition])
