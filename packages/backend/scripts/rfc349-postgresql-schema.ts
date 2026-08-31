#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildPostgresqlSchemaPlan,
  renderPostgresqlBaselineSql,
} from '../src/platform/persistence/postgresqlSchema'
import { canonicalSchemaJson } from '../src/platform/persistence/schemaContract'

const plan = buildPostgresqlSchemaPlan()
const root = resolve(import.meta.dir, '..', 'db', 'postgresql-migrations')
const metadata = resolve(root, 'meta')
mkdirSync(metadata, { recursive: true })
writeFileSync(resolve(root, '0000_rfc349_baseline.sql'), renderPostgresqlBaselineSql(plan))
writeFileSync(
  resolve(metadata, '_journal.json'),
  canonicalSchemaJson({
    version: 1,
    baselineId: plan.baselineId,
    contractDigest: plan.contractDigest,
    planDigest: plan.digest,
    activeTableCount: plan.activeTableCount,
    archiveOnlyTableCount: plan.archiveOnlyTableCount,
    statements: plan.statements.map((statement) => ({
      kind: statement.kind,
      logicalId: statement.logicalId,
      digest: `sha256:${createHash('sha256').update(statement.sql).digest('hex')}`,
    })),
  }),
)
console.log(
  `RFC-349 PostgreSQL baseline generated (${plan.activeTableCount} active tables, ${plan.digest})`,
)
