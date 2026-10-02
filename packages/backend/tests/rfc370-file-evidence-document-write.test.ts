// RFC-370 A2: the default document writer retains bytes, budget and one-shot cleanup.
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createFileEvidenceDocumentCommands } from '@/modules/development-automation/infrastructure/local/fileEvidenceDocumentCommands'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/evidenceStore'

test('local document import waits for its ACK and cleans the original staging tree on success and rejection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rfc370-evidence-document-write-'))
  try {
    const stagingRoot = join(root, 'staging')
    const store = new EvidenceStore(join(root, 'evidence'))
    const entered = Promise.withResolvers<void>()
    const ack = Promise.withResolvers<void>()
    let pendingDirectory = ''
    const budget = { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 }
    const content = '{"message":"中文"}\n'
    const commands = createFileEvidenceDocumentCommands({
      stagingRoot,
      evidence: {
        async importStagedTree(directory, actualBudget) {
          pendingDirectory = directory
          expect(actualBudget).toBe(budget)
          expect(readFileSync(join(directory, 'document.json'), 'utf8')).toBe(content)
          entered.resolve()
          await ack.promise
          return await store.importStagedTree(directory, actualBudget)
        },
      },
    })
    let complete = false
    const writing = commands.writeDocument({ relativePath: 'document.json', content, budget })
    const pending = Promise.resolve(writing).finally(() => {
      complete = true
    })
    try {
      await entered.promise
      expect(complete).toBe(false)
      expect(readdirSync(stagingRoot)).toHaveLength(1)
      expect(dirname(pendingDirectory)).toBe(stagingRoot)
    } finally {
      ack.resolve()
    }
    const bundle = await pending
    expect(bundle.entries).toHaveLength(1)
    expect(readFileSync(store.blobPath(bundle.entries[0]!.sha256), 'utf8')).toBe(content)
    expect(bundle.totalBytes).toBe(new TextEncoder().encode(content).byteLength)
    expect(readdirSync(stagingRoot)).toEqual([])
    const local = createFileEvidenceDocumentCommands({ stagingRoot, evidence: store })
    await expect(
      Promise.resolve(
        local.writeDocument({
          relativePath: 'large.json',
          content,
          budget: { maxFiles: 1, maxFileBytes: 1, maxTotalBytes: 1 },
        }),
      ),
    ).rejects.toThrow('budget: file too large')
    expect(readdirSync(stagingRoot)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
