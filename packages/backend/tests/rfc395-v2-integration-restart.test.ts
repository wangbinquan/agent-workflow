import { expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { integrationInput, convertIntegration } from './helpers/model/mixedIntegration'
import { sinkDigests, rowsDigest } from './helpers/rfc395V2/integration'
import { seedMixedInstance } from './helpers/rfc395V2/integrationFixtures'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import type { UnitOutput } from '@/platform/persistence/migration/conversion/types'
import { SourceBlockedError } from '@/platform/persistence/migration/sourceTypes'

class LoseSeventhAcknowledgement extends V2MemorySink {
  private armed = true
  override async commitUnit(output: UnitOutput): Promise<void> {
    if (this.armed && !this.units.has(output.receipt.unitId) && this.units.size === 6) {
      this.armed = false
      this.loseAcknowledgementOnce = true
    }
    await super.commitUnit(output)
  }
}

describeV2Providers('RFC-395 V2 full-assembly restart binding', (h) => {
  test('seven persisted units, lost acknowledgement, fresh reader retry: identical receipts/rows; changed source refused', async () => {
    await h.install()
    await seedMixedInstance(h)
    const interruptedInput = await integrationInput(h)
    const sink = new LoseSeventhAcknowledgement()
    try {
      await expect(runConversion(interruptedInput, sink)).rejects.toThrow(
        'v2-sink-lost-acknowledgement',
      )
    } finally {
      await interruptedInput.source.close()
    }
    expect(sink.units.size).toBe(7)
    expect(sink.summary).toBeNull()
    const committed = sinkDigests(sink)
    const retry = await integrationInput(h)
    try {
      const result = await convertIntegration(retry, sink)
      expect(result.summary.blocks).toEqual([])
      expect(result.summary.historyOnly).toEqual([])
      for (const [id, digest] of committed) expect(sink.units.get(id!)!.receipt.digest).toBe(digest)
      const clean = new V2MemorySink()
      const cleanSummary = await runConversion(retry, clean)
      expect(cleanSummary).toEqual(result.summary)
      expect(sinkDigests(sink)).toEqual(sinkDigests(clean))
      expect(rowsDigest(sink)).toBe(rowsDigest(clean))
      expect(sink.units.size).toBe(clean.units.size)
      expect(
        JSON.parse(String(sink.rows('intent_apply_journal')[0]!.prepared_artifacts_json)),
      ).toMatchObject({ scene: 'intent', version: 3, artifacts: [{ operationId: 'original-op' }] })
      expect(
        JSON.parse(String(sink.rows('resource_bundle_applies')[0]!.prepared_artifacts_json)),
      ).toEqual({ scene: 'resource-package', version: 2, artifacts: [] })
      // convertIntegration also checks global target uniqueness and every source key exactly once.
    } finally {
      await retry.source.close()
    }
    const completedDigests = sinkDigests(sink)
    const completedRows = rowsDigest(sink)
    await h.write('maintenance_state', [
      { key: 'changed-after-freeze', value: 'new source row', updated_at: 999 },
    ])
    const changed = await integrationInput(h)
    try {
      expect(changed.preflight.watermark).not.toBe(retry.preflight.watermark)
      // Same reader with stale freeze must fail before sink acknowledgement; a fresh freeze
      // must still be rejected by the existing sink's durable run binding.
      await expect(
        runConversion({ ...changed, preflight: retry.preflight }, sink),
      ).rejects.toBeInstanceOf(SourceBlockedError)
      await expect(runConversion(changed, sink)).rejects.toThrow('v2-sink-binding-mismatch')
      expect(sinkDigests(sink)).toEqual(completedDigests)
      expect(rowsDigest(sink)).toBe(completedRows)
    } finally {
      await changed.source.close()
    }
  }, 300_000)
})
