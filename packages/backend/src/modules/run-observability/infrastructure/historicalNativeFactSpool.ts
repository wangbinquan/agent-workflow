import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sha256Hex } from '@/util/hash'
import type {
  HistoricalNativeFactManifest,
  HistoricalNativeFactSpool,
  HistoricalNativeFactTransferItem,
  HistoricalNativeFactTransferPage,
} from '../ports/historicalNativeFacts'
import { historicalNativeProofKey } from '../domain/historicalNativeFacts'
import { completeObservationSpoolDirectory } from './completeObservationFileSpool'

const initial = (value: Pick<HistoricalNativeFactManifest, 'reportId' | 'owner' | 'proof'>) =>
  sha256Hex(
    JSON.stringify([
      'original-native-fact-spool-v1',
      value.reportId,
      value.owner,
      historicalNativeProofKey(value.proof),
    ]),
  )
const digest = (page: Omit<HistoricalNativeFactTransferPage, 'digest'>) =>
  sha256Hex(JSON.stringify([page.reportId, page.ordinal, page.previousDigest, page.items]))

/** Synchronous packet reads permit bounded transport inside the original atomic writer transaction. */
export function historicalNativeFactFileSpool(appHome: string): HistoricalNativeFactSpool {
  const folder = (id: string, owner: string) =>
    resolve(completeObservationSpoolDirectory(appHome, id, owner), 'native-facts')
  return {
    async seal(input) {
      const directory = folder(input.reportId, input.owner)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      let packets = 0n,
        roots = 0n,
        pages = 0n,
        previous = initial(input),
        buffer: HistoricalNativeFactTransferItem[] = [],
        bytes = 0
      const flush = () => {
        if (!buffer.length) return
        const body = {
          reportId: input.reportId,
          ordinal: String(packets),
          previousDigest: previous,
          items: buffer,
        }
        const page: HistoricalNativeFactTransferPage = { ...body, digest: digest(body) }
        writeFileSync(resolve(directory, String(packets) + '.json'), JSON.stringify(page), {
          flag: 'wx',
          mode: 0o600,
        })
        previous = page.digest
        packets++
        buffer = []
        bytes = 0
      }
      for await (const item of input.items) {
        input.signal?.throwIfAborted()
        const size = Buffer.byteLength(JSON.stringify(item))
        if (buffer.length && (buffer.length >= 16 || bytes + size > 512 * 1024)) flush()
        buffer.push(item)
        bytes += size
        if (item.kind === 'root') roots++
        else pages++
      }
      input.signal?.throwIfAborted()
      flush()
      const manifest: HistoricalNativeFactManifest = {
        reportId: input.reportId,
        owner: input.owner,
        proof: input.proof,
        packets: String(packets),
        roots: String(roots),
        pages: String(pages),
        digest: previous,
      }
      writeFileSync(resolve(directory, 'sealed.json'), JSON.stringify(manifest), {
        flag: 'wx',
        mode: 0o600,
      })
      return manifest
    },
    *pages(manifest, signal) {
      const directory = folder(manifest.reportId, manifest.owner)
      if (readFileSync(resolve(directory, 'sealed.json'), 'utf8') !== JSON.stringify(manifest))
        throw new Error('Original native fact manifest changed')
      let packets = 0n,
        roots = 0n,
        pages = 0n,
        previous = initial(manifest)
      if (
        !/^(0|[1-9]\d*)$/.test(manifest.packets) ||
        !/^(0|[1-9]\d*)$/.test(manifest.roots) ||
        !/^(0|[1-9]\d*)$/.test(manifest.pages)
      )
        throw new Error('Original native fact manifest counts invalid')
      while (packets < BigInt(manifest.packets)) {
        signal?.throwIfAborted()
        const packet = JSON.parse(
          readFileSync(resolve(directory, String(packets) + '.json'), 'utf8'),
        ) as HistoricalNativeFactTransferPage
        if (
          packet.reportId !== manifest.reportId ||
          packet.ordinal !== String(packets) ||
          packet.previousDigest !== previous ||
          !Array.isArray(packet.items) ||
          packet.items.length === 0 ||
          packet.digest !== digest(packet)
        )
          throw new Error('Original native fact transfer packet changed')
        for (const item of packet.items) {
          if (item.kind === 'root') roots++
          else if (item.kind === 'page') pages++
          else throw new Error('Original native fact transfer item invalid')
        }
        previous = packet.digest
        packets++
        yield packet
      }
      if (
        String(packets) !== manifest.packets ||
        String(roots) !== manifest.roots ||
        String(pages) !== manifest.pages ||
        previous !== manifest.digest
      )
        throw new Error('Original native fact transfer EOF incomplete')
    },
  }
}
