import type { TaskArchiveSource } from '@/platform/contracts/taskArchive'

/** In-memory archive fixture; preserve the v2 missing-empty-table convention. */
export function createTaskArchiveTextSource(input: {
  readonly directory: string
  readonly resolve: (directory: string, filename: string) => string
  readonly exists: (reference: string) => Promise<boolean>
  readonly readText: (reference: string) => Promise<string>
}): TaskArchiveSource {
  return {
    readManifest: async () =>
      new TextEncoder().encode(
        await input.readText(input.resolve(input.directory, 'manifest.json')),
      ),
    async *readTable(table) {
      const reference = input.resolve(input.directory, `db/${table}.jsonl`)
      if (await input.exists(reference))
        yield new TextEncoder().encode(await input.readText(reference))
    },
  }
}
