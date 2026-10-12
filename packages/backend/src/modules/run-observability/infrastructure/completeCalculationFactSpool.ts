import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sha256Hex } from '@/util/hash'
import {
  calculationSourceKey,
  CompleteCalculationInvalid,
} from '../domain/completeCalculationFacts'
import type {
  CompleteCalculationFactManifest,
  CompleteCalculationFactPage,
  CompleteCalculationFactItem,
  CompleteCalculationFactSpool,
} from '../ports/completeCalculationFacts'
import { completeObservationSpoolDirectory } from './completeObservationFileSpool'

const initial = (
  manifest: Pick<CompleteCalculationFactManifest, 'reportId' | 'owner' | 'context'>,
) =>
  sha256Hex(
    JSON.stringify([
      'task-calculation-spool-v1',
      manifest.reportId,
      manifest.owner,
      calculationSourceKey(manifest.context),
    ]),
  )
const digest = (page: Omit<CompleteCalculationFactPage, 'digest'>) =>
  sha256Hex(JSON.stringify([page.reportId, page.ordinal, page.previousDigest, page.items]))
function originalPacketText(path: string) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string })?.code === 'ENOENT')
      throw new CompleteCalculationInvalid('Task calculation packet missing')
    throw error
  }
}
function originalPacket(path: string): CompleteCalculationFactPage {
  const text = originalPacketText(path)
  try {
    return JSON.parse(text) as CompleteCalculationFactPage
  } catch {
    throw new CompleteCalculationInvalid('Task calculation packet cannot be decoded')
  }
}

/** Packets bound only transport; every version and row is sealed through EOF. */
export function completeCalculationFactFileSpool(appHome: string): CompleteCalculationFactSpool {
  const folder = (id: string, owner: string) =>
    resolve(completeObservationSpoolDirectory(appHome, id, owner), 'task-calculations')
  return {
    async seal(input) {
      const directory = folder(input.reportId, input.owner)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      let packets = 0n,
        versions = 0n,
        rows = 0n,
        previous = initial(input),
        bytes = 0
      let buffer: CompleteCalculationFactItem[] = []
      const flush = () => {
        if (buffer.length === 0) return
        const body = {
          reportId: input.reportId,
          ordinal: String(packets),
          previousDigest: previous,
          items: buffer,
        }
        const packet: CompleteCalculationFactPage = { ...body, digest: digest(body) }
        writeFileSync(resolve(directory, String(packets) + '.json'), JSON.stringify(packet), {
          flag: 'wx',
          mode: 0o600,
        })
        packets++
        previous = packet.digest
        bytes = 0
        buffer = []
      }
      for await (const item of input.items) {
        input.signal?.throwIfAborted()
        const size = Buffer.byteLength(JSON.stringify(item))
        if (buffer.length && (buffer.length >= 256 || bytes + size > 1024 * 1024)) flush()
        buffer.push(item)
        bytes += size
        if (item.kind === 'version') versions++
        else rows++
      }
      input.signal?.throwIfAborted()
      flush()
      const manifest: CompleteCalculationFactManifest = {
        reportId: input.reportId,
        owner: input.owner,
        context: input.context,
        packets: String(packets),
        versions: String(versions),
        rows: String(rows),
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
      if (originalPacketText(resolve(directory, 'sealed.json')) !== JSON.stringify(manifest))
        throw new CompleteCalculationInvalid('Task calculation manifest changed')
      if (
        [manifest.packets, manifest.versions, manifest.rows].some(
          (value) => !/^(0|[1-9]\d*)$/.test(value),
        )
      )
        throw new CompleteCalculationInvalid('Task calculation manifest counts invalid')
      let packets = 0n,
        versions = 0n,
        rows = 0n,
        previous = initial(manifest)
      while (packets < BigInt(manifest.packets)) {
        signal?.throwIfAborted()
        const packet = originalPacket(resolve(directory, String(packets) + '.json'))
        if (
          packet.reportId !== manifest.reportId ||
          packet.ordinal !== String(packets) ||
          packet.previousDigest !== previous ||
          !Array.isArray(packet.items) ||
          packet.items.length === 0 ||
          packet.digest !== digest(packet)
        )
          throw new CompleteCalculationInvalid('Task calculation packet changed')
        for (const item of packet.items) {
          if (item.kind === 'version') versions++
          else if (item.kind === 'row') rows++
          else throw new CompleteCalculationInvalid('Task calculation item invalid')
        }
        previous = packet.digest
        packets++
        yield packet
      }
      if (
        String(packets) !== manifest.packets ||
        String(versions) !== manifest.versions ||
        String(rows) !== manifest.rows ||
        previous !== manifest.digest
      )
        throw new CompleteCalculationInvalid('Task calculation transport EOF incomplete')
    },
  }
}
