import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { sha256Hex } from '@/util/hash'
import {
  completeReportInitialDigest,
  completeReportTransferPage,
  assertCompleteReportTransferPage,
  assertCompleteReportManifest,
} from '../domain/completeReportEnvelope'
import type {
  CompleteObservationSpool,
  CompleteObservationManifest,
  CompleteObservationTransferItem,
  CompleteObservationTransferPage,
} from '../ports/completeObservationReport'

/** Sealed derived transport on the original configured operations root, never an input database. */
export function completeObservationFileSpool(appHome: string): CompleteObservationSpool {
  if (!isAbsolute(appHome)) throw new Error('Original report operations root must be absolute')
  const folder = (id: string, owner: string) => {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id) || !owner)
      throw new Error('Complete report spool identity invalid')
    return resolve(appHome, 'operations', 'observation-reports', id, sha256Hex(owner))
  }
  return {
    async seal(input) {
      if (input.summary.metrics.state === 'not-ready' || input.header.reportId !== input.reportId)
        throw new Error('Incomplete original statistics cannot be sealed')
      const directory = folder(input.reportId, input.owner)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      let pages = 0n,
        rows = 0n,
        counts = 0n,
        receipts = 0n,
        digest = completeReportInitialDigest
      let buffer: CompleteObservationTransferItem[] = []
      const flush = () => {
        if (!buffer.length) return
        const page = completeReportTransferPage(
          input.reportId,
          String(pages),
          digest,
          buffer,
          sha256Hex,
        )
        writeFileSync(resolve(directory, String(pages) + '.json'), JSON.stringify(page), {
          flag: 'wx',
          mode: 0o600,
        })
        digest = page.digest
        pages++
        buffer = []
      }
      for await (const item of input.items) {
        input.signal?.throwIfAborted()
        buffer.push(item)
        if (item.kind === 'row') rows++
        else if (item.kind === 'count') counts++
        else receipts++
        if (buffer.length === 500) flush()
      }
      input.signal?.throwIfAborted()
      flush()
      const manifest: CompleteObservationManifest = {
        reportId: input.reportId,
        owner: input.owner,
        requestKey: input.requestKey,
        header: input.header,
        summary: input.summary,
        pages: String(pages),
        rows: String(rows),
        counts: String(counts),
        receipts: String(receipts),
        digest,
      }
      writeFileSync(resolve(directory, 'sealed.json'), JSON.stringify(manifest), {
        flag: 'wx',
        mode: 0o600,
      })
      return manifest
    },
    async *pages(manifest, signal) {
      const directory = folder(manifest.reportId, manifest.owner)
      if (readFileSync(resolve(directory, 'sealed.json'), 'utf8') !== JSON.stringify(manifest))
        throw new Error('Original sealed manifest changed')
      const actual = {
        pages: 0n,
        rows: 0n,
        counts: 0n,
        receipts: 0n,
        digest: completeReportInitialDigest,
      }
      while (actual.pages < BigInt(manifest.pages)) {
        signal?.throwIfAborted()
        const page = JSON.parse(
          readFileSync(resolve(directory, String(actual.pages) + '.json'), 'utf8'),
        ) as CompleteObservationTransferPage
        assertCompleteReportTransferPage(
          page,
          manifest.reportId,
          String(actual.pages),
          actual.digest,
          sha256Hex,
        )
        for (const item of page.items) {
          if (item.kind === 'row') actual.rows++
          else if (item.kind === 'count') actual.counts++
          else if (item.kind === 'receipt') actual.receipts++
          else throw new Error('Unknown complete report transfer item')
        }
        actual.digest = page.digest
        actual.pages++
        yield page
      }
      assertCompleteReportManifest(actual, manifest)
    },
    async remove(id, owner) {
      rmSync(folder(id, owner), { recursive: true, force: true })
    },
  }
}
