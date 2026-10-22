import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/local/fileEvidenceStore'
import { createGraphDesignArtifacts } from '@/modules/development-automation/infrastructure/graph-development/designArtifacts'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'rfc396-artifact-reading-'))
  homes.push(home)
  const store = new EvidenceStore(home)
  const state = {
    active: 0,
    peak: 0,
    manifests: 0,
    fault: 'none' as 'none' | 'missing' | 'corrupt',
  }
  async function transfer(read: () => string | null | Promise<string | null>) {
    state.active++
    state.peak = Math.max(state.peak, state.active)
    try {
      if (state.active > 2) throw new Error('object-storage-429')
      const content = await read()
      return state.fault === 'missing' ? null : state.fault === 'corrupt' ? `${content}!` : content
    } finally {
      state.active--
    }
  }
  const limited = new Proxy(store, {
    get(target, key) {
      if (key === 'contents')
        return {
          ...target.contents,
          readText: (ref: string) => transfer(() => target.contents.readText(ref)),
        }
      if (key === 'documents')
        return {
          ...target.documents,
          readText: (request: Parameters<typeof target.documents.readText>[0]) =>
            transfer(() => target.documents.readText(request)),
        }
      if (key === 'getBundle')
        return (ref: string) => {
          state.manifests++
          return target.getBundle(ref)
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { artifacts: createGraphDesignArtifacts(limited), state }
}

test('complete frozen materials remain readable under a two-transfer hosted quota', async () => {
  const { artifacts, state } = fixture()
  const files = Array.from({ length: 8 }, (_, i) => ({
    path: `file-${i}.md`,
    content: `原始回答 ${i}\n全部保留\n`,
  }))
  const reference = await artifacts.put(files)
  expect(await artifacts.files(reference)).toEqual(files)
  expect(state.peak).toBe(1)
  expect(state.manifests).toBe(1)
  expect(await artifacts.read(reference, files[0]!.path)).toBe(files[0]!.content)
  expect(state.manifests).toBe(2)
})

test('quota-safe reads still reject missing bytes, corrupt contents and a changed manifest', async () => {
  const { artifacts, state } = fixture()
  const reference = await artifacts.put([
    { path: 'implementation.md', content: 'exact approved basis' },
  ])
  state.fault = 'missing'
  await expect(artifacts.files(reference)).rejects.toThrow(
    'graph-artifact-file-missing: implementation.md',
  )
  state.fault = 'corrupt'
  await expect(artifacts.files(reference)).rejects.toThrow('graph-artifact-content-digest-mismatch')
  await expect(artifacts.read(reference, 'implementation.md')).rejects.toThrow(
    'graph-artifact-content-digest-mismatch',
  )
  state.fault = 'none'
  await expect(artifacts.files({ ...reference, digest: '0'.repeat(64) })).rejects.toThrow(
    'graph-artifact-digest-mismatch',
  )
  expect(await artifacts.read(reference, 'absent.md')).toBeNull()
})
