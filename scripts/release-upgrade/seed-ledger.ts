#!/usr/bin/env bun
/** RFC-398 T8: prepare fixtures without invoking conversion, upgrade or tests. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { format } from 'prettier'
import { FIXTURES, readRegistry } from './lib/io'
import { checkSeedLedger, deriveSeed, readApprovedExemptions } from './lib/seed-ledger'

async function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      registry: { type: 'string' },
      seeds: { type: 'string' },
      dataset: { type: 'string' },
      tag: { type: 'string' },
      migration: { type: 'string' },
      table: { type: 'string', multiple: true },
      limit: { type: 'string' },
      output: { type: 'string' },
      keep: { type: 'string' },
      'write-coverage': { type: 'boolean' },
      'require-approved-exemptions': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })
  if (values.help || !positionals.length) {
    console.log(`Bun 1.4.3: scripts/release-upgrade/seed-ledger.ts
  check [--keep /tmp/new-directory] [--output /tmp/report.json] [--write-coverage]
        [--require-approved-exemptions] [--registry path] [--seeds path]
  derive --dataset /tmp/recording --tag v0.19.2 --migration NNNN_tag
         --output /tmp/new-draft.json [--table table] [--limit 3]
check performs SQLite receipt/seed data preparation only. It does not run upgrade or HTTP acceptance.
derive refuses to overwrite output; a derived-draft must be reviewed before check accepts it.`)
    return
  }
  const registry = readRegistry(values.registry)
  const json = (value: unknown) => format(JSON.stringify(value), { parser: 'json-stringify' })
  if (positionals[0] === 'derive') {
    if (!values.dataset || !values.tag || !values.migration || !values.output)
      throw new Error('derive requires --dataset, --tag, --migration and --output')
    const release = registry.releases.find((entry) => entry.tag === values.tag)
    if (!release) throw new Error(`Unknown release ${values.tag}`)
    const limit = values.limit === undefined ? 3 : Number(values.limit)
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error('--limit must be a positive integer')
    const output = resolve(values.output)
    if (existsSync(output)) throw new Error(`Refusing to overwrite ${output}`)
    const draft = deriveSeed({
      dataset: resolve(values.dataset),
      release,
      migration: values.migration,
      tables: values.table,
      limit,
    })
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, await json(draft), { flag: 'wx' })
    console.log(`Draft: ${output} (${draft.rows.length} rows; review required)`)
  } else if (positionals[0] === 'check') {
    const coveragePath = join(FIXTURES, 'coverage.json')
    const exemptions = readApprovedExemptions()
    const report = checkSeedLedger(registry, {
      seeds: values.seeds,
      keep: values.keep ? resolve(values.keep) : undefined,
      exemptions,
      onBuild(build) {
        const covered = build.tables.filter((table) => table.rows > 0).length
        const missing = build.tables
          .filter((table) => table.coverage === 'missing')
          .map((table) => table.table)
        const exempt = build.tables
          .filter((table) => table.coverage === 'exempt')
          .map((table) => table.table)
        console.log(
          `${build.tags.join(',')} | ${covered}/${build.tables.length} tables | ${exempt.length} exemptions | ${build.failures.length} failures`,
        )
        if (missing.length) console.log(`  EMPTY: ${missing.join(', ')}`)
        if (exempt.length) console.log(`  EXEMPT (see approval status): ${exempt.join(', ')}`)
        for (const failure of build.failures) console.log(`  ${failure.phase}: ${failure.detail}`)
      },
    })
    if (values.output) writeFileSync(resolve(values.output), await json(report))
    if (values['write-coverage']) {
      if (report.builds.some((build) => build.failures.length))
        throw new Error('Refusing to write a partial coverage ledger after reconstruction failures')
      writeFileSync(coveragePath, await json(report))
    }
    const failed = report.builds.filter(
      (build) =>
        build.failures.length || build.tables.some((table) => table.coverage === 'missing'),
    )
    console.log(
      `${report.builds.length} builds / ${registry.releases.length} releases; ${failed.length} failing builds; ${exemptions.length} user-approved exemptions. Conversion and API acceptance: NOT RUN.`,
    )
    // Approval is mandatory even without the retained compatibility flag.
    if (failed.length) process.exitCode = 1
  } else throw new Error(`Unknown command: ${positionals[0]}`)
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
