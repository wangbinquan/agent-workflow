import { existsSync, readFileSync } from 'node:fs'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  parseGenerationPointerV2,
  replaceGenerationPointerBytes,
  restorePreviousPointerBytes,
  writeGenerationPointerV2,
} from '@/platform/persistence/generationPointerV2'
import type { ActivationPort, EpochSwitchJournalPort } from '../../application/ports/epochSwitch'
import { parseActivationReceipt } from '../../domain/epochSwitch/documents'
import { EpochSwitchError, type EpochSwitchFaults } from '../../domain/epochSwitch/model'

export interface PointerActivationOptions {
  pointerPath: string
  journal: EpochSwitchJournalPort
  faults?: EpochSwitchFaults
}

/** Both standalone providers commit by replacing this one pointer. */
export function createPointerEpochActivation(input: PointerActivationOptions): ActivationPort {
  return {
    async activate({ journal, receiptDigest, pointer }) {
      if (
        !pointer ||
        pointer.manifestDigest !== receiptDigest ||
        pointer.operationId !== journal.payload.operationId ||
        pointer.generationId !== journal.payload.target.generationId
      )
        throw new EpochSwitchError('v3-pointer-activation-binding', {
          category: 'activation-failed',
        })
      const bytes = await input.journal.readArtifact(
        journal.payload.operationId,
        'activation-receipt.json',
      )
      if (
        !bytes ||
        parseActivationReceipt(Buffer.from(bytes).toString('utf8')).digest !== receiptDigest
      )
        throw new EpochSwitchError('v3-activation-receipt-missing', {
          category: 'activation-failed',
        })
      const written = writeGenerationPointerV2({
        pointerPath: input.pointerPath,
        payload: pointer,
        onCrashPoint: input.faults,
      })
      return { pointerDigest: written.digest }
    },
    async observe(op) {
      const journal = await input.journal.read(op)
      if (!journal) throw new EpochSwitchError('v3-operation-not-found')
      if (!existsSync(input.pointerPath))
        return {
          pointsAt: journal.payload.source.pointer.bytesBase64 === null ? 'none' : 'other',
          pointerDigest: null,
        }
      const bytes = readFileSync(input.pointerPath)
      if (bytesDigest(bytes) === journal.payload.source.pointer.digest)
        return { pointsAt: 'source', pointerDigest: journal.payload.source.pointer.digest }
      try {
        const pointer = parseGenerationPointerV2(bytes.toString('utf8'))
        const receiptBytes = await input.journal.readArtifact(op, 'activation-receipt.json')
        const receipt = receiptBytes
          ? parseActivationReceipt(Buffer.from(receiptBytes).toString('utf8'))
          : null
        if (
          pointer.payload.operationId === op &&
          pointer.payload.generationId === journal.payload.target.generationId &&
          receipt &&
          pointer.payload.manifestDigest === receipt.digest
        )
          return { pointsAt: 'target', pointerDigest: pointer.digest }
        return { pointsAt: 'other', pointerDigest: pointer.digest }
      } catch {
        return { pointsAt: 'other', pointerDigest: bytesDigest(bytes) }
      }
    },
    async restorePrevious({ previousBytes, firstLiveWriteAt }) {
      if (firstLiveWriteAt !== null)
        throw new EpochSwitchError('reverse-migration-required', {
          category: 'reverse-migration-required',
        })
      if (previousBytes !== null)
        replaceGenerationPointerBytes({
          pointerPath: input.pointerPath,
          bytes: previousBytes,
          onCrashPoint: (point) => input.faults?.(`rollback-${point}`),
        })
      else {
        restorePreviousPointerBytes({
          pointerPath: input.pointerPath,
          previousBytes,
          firstLiveWriteAt,
        })
        input.faults?.('rollback-renamed')
        input.faults?.('rollback-directory-synced')
      }
    },
  }
}
