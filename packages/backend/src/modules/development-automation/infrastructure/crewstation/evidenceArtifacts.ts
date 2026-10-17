import { ulid } from 'ulid'
import { z } from 'zod'
import type {
  CrewStationStreamObjectStorage,
  HostedObjectStream,
} from '@/platform/crewstation/objectStorage'
import type { HostedObjectPublications } from '@/modules/system-operations/public/participants'
import {
  DEVELOPMENT_EVIDENCE_OWNER,
  retainDevelopmentObjectInTx,
  type DevelopmentObjectIndex,
} from './objectIndex'
import type { EvidenceArtifactPort } from '../../application/ports/evidenceArtifacts'
import type { EvidenceDocumentCommands } from '../../application/evidenceDocumentCommands'
import { EVIDENCE_READ_MAX_BYTES } from '../../application/pipelineEvidenceRead'
import type { EvidenceBudget, EvidenceBundleRecord, EvidenceEntry } from '../../domain/evidence'
import { sha256Hex } from '@/util/hash'

const SHA = /^[a-f0-9]{64}$/
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/
export function assertEvidenceRelativePath(path: string): void {
  if (
    !path ||
    path.length > 4096 ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[a-zA-Z]:/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('hosted-evidence-path-invalid')
}
const Bundle = z
  .object({
    bundleId: z.string().regex(ULID),
    entries: z.array(
      z
        .object({
          relativePath: z.string(),
          bytes: z.number().int().nonnegative(),
          sha256: z.string().regex(SHA),
        })
        .strict(),
    ),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict()

export interface HostedEvidenceFiles {
  inspect(reference: string): Promise<HostedObjectStream>
  scan(
    root: string,
    budget: EvidenceBudget,
  ): Promise<readonly { relativePath: string; reference: string; size: number }[]>
  write(
    reference: string,
    stream: ReadableStream<Uint8Array>,
    facts: { size: number; sha256: string },
  ): Promise<void>
  join(root: string, relative: string): string
}

function assertBudget(
  entries: readonly { relativePath: string; size: number }[],
  budget: EvidenceBudget,
): void {
  if (
    ![budget.maxFiles, budget.maxFileBytes, budget.maxTotalBytes].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    throw new Error('hosted-evidence-budget-invalid')
  if (entries.length > budget.maxFiles) throw new Error('budget: too many files')
  let total = 0
  const paths = new Set<string>()
  for (const entry of entries) {
    assertEvidenceRelativePath(entry.relativePath)
    if (paths.has(entry.relativePath)) throw new Error('hosted-evidence-duplicate-path')
    paths.add(entry.relativePath)
    if (!Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new Error('hosted-evidence-size-invalid')
    if (entry.size > budget.maxFileBytes) throw new Error('budget: file too large')
    total += entry.size
    if (total > budget.maxTotalBytes) throw new Error('budget: total too large')
  }
}

/** Existing SHA/ULID business identities survive restarts; bytes live only in CS.
 * Native evidence retention deliberately keeps blobs without a complete live
 * reference graph, so development evidence publications are never released. */
export function createCrewStationEvidenceArtifacts(input: {
  readonly objects: CrewStationStreamObjectStorage
  readonly index: DevelopmentObjectIndex
  readonly publications: Pick<HostedObjectPublications, 'publish'>
  readonly files: HostedEvidenceFiles
}): { readonly artifacts: EvidenceArtifactPort; readonly documents: EvidenceDocumentCommands } {
  const publish = async (reference: string, content: HostedObjectStream) => {
    if (reference.startsWith('blob:') && reference !== `blob:${content.sha256}`)
      throw new Error('hosted-development-upload-content-changed')
    await input.publications.publish(
      [{ owner: DEVELOPMENT_EVIDENCE_OWNER, key: reference, content }],
      {
        commit: (tx, [object]) => retainDevelopmentObjectInTx(tx, reference, object!),
      },
    )
  }
  const findBlob = (ref: string) =>
    SHA.test(ref) ? input.index.find(`blob:${ref}`) : Promise.resolve(null)
  const put = async (content: HostedObjectStream) => {
    const reference = `blob:${content.sha256}`
    const existing = await input.index.find(reference)
    if (existing !== null) {
      if (existing.sha256 !== content.sha256 || existing.size !== content.size)
        throw new Error('hosted-evidence-object-mismatch')
    } else {
      await publish(reference, content)
    }
    return { sha256: content.sha256, bytes: content.size }
  }
  const putText = (text: string) => {
    const bytes = Buffer.from(text, 'utf8')
    return put({
      sha256: sha256Hex(bytes),
      size: bytes.length,
      open: () => new Blob([bytes]).stream(),
    })
  }
  const readText = async (reference: string) => {
    const object = await findBlob(reference)
    return object === null ? null : new Response(await input.objects.open(object)).text()
  }
  const retainBundle = async (
    entries: readonly EvidenceEntry[],
    bundleId = ulid(),
  ): Promise<EvidenceBundleRecord> => {
    const bundle = {
      bundleId,
      entries: [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      totalBytes: entries.reduce((n, entry) => n + entry.bytes, 0),
    }
    const bytes = Buffer.from(JSON.stringify(bundle))
    await publish(`bundle:${bundleId}`, {
      sha256: sha256Hex(bytes),
      size: bytes.length,
      open: () => new Blob([bytes]).stream(),
    })
    return bundle
  }
  const getBundle = async (ref: string): Promise<EvidenceBundleRecord | null> => {
    if (!ULID.test(ref)) return null
    const object = await input.index.find(`bundle:${ref}`)
    if (object === null) return null
    const bundle = Bundle.parse(await new Response(await input.objects.open(object)).json())
    if (
      bundle.bundleId !== ref ||
      bundle.totalBytes !== bundle.entries.reduce((n, e) => n + e.bytes, 0)
    )
      throw new Error('hosted-evidence-manifest-mismatch')
    assertBudget(
      bundle.entries.map((e) => ({ relativePath: e.relativePath, size: e.bytes })),
      {
        maxFiles: Number.MAX_SAFE_INTEGER,
        maxFileBytes: Number.MAX_SAFE_INTEGER,
        maxTotalBytes: Number.MAX_SAFE_INTEGER,
      },
    )
    return bundle
  }
  const putFile = async (reference: string) => put(await input.files.inspect(reference))
  const artifacts: EvidenceArtifactPort = {
    putFile,
    putBlobFromFile: putFile,
    getBundle,
    async importStagedTree(root, budget) {
      const files = await input.files.scan(root, budget)
      assertBudget(files, budget)
      const entries: EvidenceEntry[] = []
      for (const file of files) {
        const blob = await putFile(file.reference)
        if (blob.bytes !== file.size) throw new Error('hosted-evidence-staging-changed')
        entries.push({ relativePath: file.relativePath, ...blob })
      }
      return retainBundle(entries)
    },
    async materializeBlob(ref, destination) {
      const object = await findBlob(ref)
      if (object === null) return false
      await input.files.write(destination, await input.objects.open(object), object)
      return true
    },
    async materializeBundle(ref, destination) {
      const bundle = await getBundle(ref)
      if (bundle === null) throw new Error(`evidence bundle not found: ${ref}`)
      for (const entry of bundle.entries) {
        const object = await findBlob(entry.sha256)
        if (object === null || object.size !== entry.bytes || object.sha256 !== entry.sha256)
          throw new Error(`evidence blob missing: ${entry.sha256} (${entry.relativePath})`)
        await input.files.write(
          input.files.join(destination, entry.relativePath),
          await input.objects.open(object),
          object,
        )
      }
      return [...bundle.entries]
    },
    async hasBlob(ref) {
      return (await findBlob(ref)) !== null
    },
    contexts: { save: async (text) => (await putText(text)).sha256, load: readText },
    contents: {
      readText,
      async readRange({ sha256, offsetBytes, limitBytes }) {
        if (
          !Number.isSafeInteger(offsetBytes) ||
          offsetBytes < 0 ||
          !Number.isSafeInteger(limitBytes) ||
          limitBytes <= 0
        )
          return { ok: false, code: 'range-invalid' }
        const object = await findBlob(sha256)
        if (object === null) return { ok: false, code: 'evidence-file-missing' }
        if (offsetBytes >= object.size)
          return {
            ok: true,
            bytes: new Uint8Array(),
            totalBytes: object.size,
            truncated: false,
            nextOffset: null,
          }
        const end = Math.min(
          object.size,
          offsetBytes + Math.min(limitBytes, EVIDENCE_READ_MAX_BYTES),
        )
        const bytes = new Uint8Array(
          await new Response(
            await input.objects.open(object, { start: offsetBytes, end: end - 1 }),
          ).arrayBuffer(),
        )
        return {
          ok: true,
          bytes,
          totalBytes: object.size,
          truncated: end < object.size,
          nextOffset: end < object.size ? end : null,
        }
      },
    },
    documents: {
      async readText({ bundleRef, relativePath }) {
        const bundle = await getBundle(bundleRef)
        const entry = bundle?.entries.find((e) => e.relativePath === relativePath)
        return entry === undefined ? null : readText(entry.sha256)
      },
    },
    downloads: {
      async open(ref) {
        const object = await findBlob(ref)
        return object === null
          ? null
          : {
              openAll: () => input.objects.open(object),
              open: (start: number, end: number) => input.objects.open(object, { start, end }),
            }
      },
    },
  }
  return {
    artifacts,
    documents: {
      async writeDocument({ relativePath, content, budget }) {
        assertBudget([{ relativePath, size: Buffer.byteLength(content, 'utf8') }], budget)
        return retainBundle([{ relativePath, ...(await putText(content)) }])
      },
    },
  }
}
