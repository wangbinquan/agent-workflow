import type {
  ConversionRunBinding,
  ConversionSink,
  ConversionSummary,
} from '@/platform/persistence/migration/conversion/sink'
import type { UnitOutput, TargetRow } from '@/platform/persistence/migration/conversion/types'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { encodeStagedValue } from '@/platform/persistence/migration/conversion/staging'

export class V2MemorySink implements ConversionSink {
  binding: ConversionRunBinding | null = null
  readonly units = new Map<string, UnitOutput>()
  summary: ConversionSummary | null = null
  loseAcknowledgementOnce = false
  async open(binding: ConversionRunBinding): Promise<{ committedUnitIds: ReadonlySet<string> }> {
    if (this.binding && valueDigest(this.binding) !== valueDigest(binding))
      throw new Error('v2-sink-binding-mismatch')
    this.binding = structuredClone(binding)
    return { committedUnitIds: new Set(this.units.keys()) }
  }
  async commitUnit(output: UnitOutput): Promise<void> {
    if (!this.binding) throw new Error('v2-sink-not-open')
    const { digest, ...receipt } = output.receipt
    const { receipt: _receipt, ...payload } = output
    if (valueDigest({ receipt, output: encodeStagedValue(payload) }) !== digest)
      throw new Error('v2-sink-invalid-unit-digest')
    const existing = this.units.get(receipt.unitId)
    if (existing) {
      if (existing.receipt.digest !== digest) throw new Error('v2-sink-unit-conflict')
      return
    }
    this.units.set(receipt.unitId, structuredClone(output))
    if (this.loseAcknowledgementOnce) {
      this.loseAcknowledgementOnce = false
      throw new Error('v2-sink-lost-acknowledgement')
    }
  }
  async finish(summary: ConversionSummary): Promise<void> {
    this.summary = structuredClone(summary)
  }
  rows(table: string): readonly TargetRow[] {
    return [...this.units.values()].flatMap((unit) =>
      unit.rows.filter((rows) => rows.table === table).flatMap((rows) => rows.rows),
    )
  }
}
