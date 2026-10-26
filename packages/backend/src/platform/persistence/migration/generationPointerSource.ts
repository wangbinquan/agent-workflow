// RFC-395 II-b R2: epoch-1 recognition belongs only to the migration boundary.
import { existsSync, readFileSync } from 'node:fs'
import { parseDatabaseGenerationText, type DatabaseGenerationFile } from '../generationValidation'
import { parseGenerationPointerV2, type GenerationPointerV2 } from '../generationPointerV2'

export function readMigrationSourcePointer(pointerPath: string): {
  readonly bytes: Uint8Array | null
  readonly pointer: DatabaseGenerationFile | GenerationPointerV2 | null
} {
  if (!existsSync(pointerPath)) return { bytes: null, pointer: null }
  const bytes = readFileSync(pointerPath)
  const text = bytes.toString('utf8')
  const version = (JSON.parse(text) as { payload?: { version?: unknown } }).payload?.version
  return {
    bytes,
    pointer:
      version === 1
        ? parseDatabaseGenerationText(text, pointerPath)
        : parseGenerationPointerV2(text),
  }
}
