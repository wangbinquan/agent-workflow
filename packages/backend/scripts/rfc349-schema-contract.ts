// Regenerate RFC-349's canonical machine manifest and human report from the
// committed SQLite schema projection. The architecture test compares both
// artifacts byte-for-byte, so schema drift cannot be published silently.

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildLogicalSchemaContract,
  canonicalSchemaJson,
  renderLogicalSchemaReport,
} from '../src/platform/persistence/schemaContract'

const repoRoot = resolve(import.meta.dir, '..', '..', '..')
const outputDir = resolve(repoRoot, 'design', 'RFC-349-postgresql-provider-one-click-migration')
const contract = buildLogicalSchemaContract()

mkdirSync(outputDir, { recursive: true })
writeFileSync(resolve(outputDir, 'schema-contract.json'), canonicalSchemaJson(contract), 'utf8')
writeFileSync(resolve(outputDir, 'schema-contract.md'), renderLogicalSchemaReport(contract), 'utf8')

console.log(
  `RFC-349 schema contract: ${contract.sourceTableCount} source / ${contract.activeTableCount} active / ${contract.archiveOnlyTableCount} archive-only; ${contract.digest}`,
)
