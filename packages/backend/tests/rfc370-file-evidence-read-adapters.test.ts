// RFC-370 A2: the new local adapters retain real bundle/file and inclusive-range behavior.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/evidenceStore'
import { createFileEvidenceDocumentQueries } from '@/modules/development-automation/infrastructure/local/fileEvidenceDocumentQueries'
import { createFileEvidenceDownloadQueries } from '@/modules/development-automation/infrastructure/local/fileEvidenceDownloadQueries'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
test('local documents and stream handles retain exact bytes, missing entries and inclusive ranges', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rfc370-local-evidence-read-'))
  roots.push(root)
  const staging = join(root, 'staging')
  mkdirSync(staging)
  const text = '{"message":"中文"}\n'
  writeFileSync(join(staging, 'document.json'), text)
  const store = new EvidenceStore(join(root, 'evidence'))
  const bundle = await store.importStagedTree(staging, {
    maxFiles: 1,
    maxFileBytes: 1024,
    maxTotalBytes: 1024,
  })
  const entry = bundle.entries[0]!
  const deps = {
    getBundle: (ref: string) => store.getBundle(ref),
    blobPath: (ref: string) => store.blobPath(ref),
  }
  const documents = createFileEvidenceDocumentQueries(deps)
  expect(
    await documents.readText({ bundleRef: bundle.bundleId, relativePath: 'document.json' }),
  ).toBe(text)
  expect(
    await documents.readText({ bundleRef: 'missing', relativePath: 'document.json' }),
  ).toBeNull()
  expect(
    await documents.readText({ bundleRef: bundle.bundleId, relativePath: 'missing.json' }),
  ).toBeNull()
  const downloads = createFileEvidenceDownloadQueries(deps)
  const handle = await downloads.open(entry.sha256)
  expect(handle).not.toBeNull()
  if (handle === null) throw new Error('expected a real local blob')
  expect(await new Response(await handle.openAll()).text()).toBe(text)
  const actualRange = new Uint8Array(await new Response(await handle.open(2, 8)).arrayBuffer())
  expect(actualRange).toEqual(new TextEncoder().encode(text).slice(2, 9))
  rmSync(store.blobPath(entry.sha256))
  expect(await downloads.open(entry.sha256)).toBeNull()
  expect(() =>
    documents.readText({ bundleRef: bundle.bundleId, relativePath: 'document.json' }),
  ).toThrow()
})
