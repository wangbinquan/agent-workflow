// Golden payload bytes are canonical epoch-1 JSON; the ZIP avoids formatter rewrites.
import { unzipSync } from 'fflate'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
export function materializeGoldenLogical(operationRoot: string): string {
  const root = mkdtempSync(join(operationRoot, 'golden-logical-'))
  const files = unzipSync(
    readFileSync(join(import.meta.dir, '../fixtures/rfc395-v1/logical-artifact.zip')),
  )
  for (const [path, bytes] of Object.entries(files)) {
    const destination = join(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, bytes)
  }
  return root
}
