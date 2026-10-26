// Node-compatible: shared by Playwright and the Bun hosted evidence harness.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function liveSqliteGeneration(home: string): { generationId: string; path: string } {
  const pointer = JSON.parse(readFileSync(join(home, 'database-generation.json'), 'utf8')) as {
    payload?: {
      version?: number
      generationId?: string
      database?: { kind?: string; relativePath?: string }
    }
  }
  const payload = pointer.payload
  if (
    payload?.version !== 2 ||
    !payload.generationId ||
    payload.database?.kind !== 'sqlite-file' ||
    !payload.database.relativePath
  )
    throw new Error('e2e storage requires a published v2 SQLite generation')
  return { generationId: payload.generationId, path: resolve(home, payload.database.relativePath) }
}

export function liveSqlitePath(home: string): string {
  return liveSqliteGeneration(home).path
}
