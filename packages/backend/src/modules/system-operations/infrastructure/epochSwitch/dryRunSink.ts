import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import type {
  ConversionRunBinding,
  ConversionSink,
  ConversionSummary,
} from '@/platform/persistence/migration/conversion/sink'
import type { DryRunResult } from '@/platform/persistence/migration/run/types'
import { assertMigrationUnitDigest } from './conversionSink'

export function createDryRunSink(): ConversionSink & { readonly result: DryRunResult } {
  let binding: ConversionRunBinding | null = null
  let summary: ConversionSummary | null = null
  const digests = new Map<string, string>()
  const counts = new Map<string, number>()
  let rowsWritten = 0
  let dispositions = 0
  let artifacts = 0
  let archiveBytes = 0
  return {
    async open(next) {
      if (binding && valueDigest(binding) !== valueDigest(next))
        throw new Error('v3-run-binding-mismatch')
      binding = structuredClone(next)
      return { committedUnitIds: new Set(digests.keys()) }
    },
    async commitUnit(output) {
      if (!binding) throw new Error('v3-sink-not-open')
      assertMigrationUnitDigest(output)
      const existing = digests.get(output.receipt.unitId)
      if (existing) {
        if (existing !== output.receipt.digest) throw new Error('v3-sink-unit-conflict')
        return
      }
      if (summary) throw new Error('v3-sink-run-finished')
      digests.set(output.receipt.unitId, output.receipt.digest)
      for (const group of output.rows) {
        counts.set(group.table, (counts.get(group.table) ?? 0) + group.rows.length)
        rowsWritten += group.rows.length
      }
      dispositions += output.dispositions.length
      artifacts += output.artifacts.length
      archiveBytes += output.archives.reduce((sum, archive) => sum + archive.bytes.byteLength, 0)
    },
    async finish(next) {
      if (!binding) throw new Error('v3-sink-not-open')
      if (next.plan.digest !== binding.planDigest || next.stagingDigest !== binding.stagingDigest)
        throw new Error('v3-run-binding-mismatch')
      if (summary && valueDigest(summary) !== valueDigest(next))
        throw new Error('v3-sink-summary-conflict')
      summary = structuredClone(next)
    },
    get result() {
      if (!summary) throw new Error('v3-dry-run-unfinished')
      return {
        summary,
        units: digests.size,
        rowsWritten,
        dispositions,
        artifacts,
        archiveBytes,
        targetCounts: [...counts]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([table, rows]) => ({ table, rows })),
      }
    },
  }
}
