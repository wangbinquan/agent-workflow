// RFC-370 §10 V19 — the standalone program tool source: artifacts stored under
// the application home by the digital employee's local program store.
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { z } from 'zod'
import { sha256Hex } from '@/util/hash'
import type { ProgramToolSource } from '../../application/ports/scriptFixture'

const parameterValuesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))

function containedArtifact(appHome: string, artifactRef: string): string | null {
  const root = resolve(appHome)
  const absolute = resolve(root, artifactRef)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return null
  return absolute
}

const failed = (code: string, detail: string) =>
  ({ kind: 'failed', check: { code, ok: false, detail } }) as const

export function createFileProgramToolSource(appHome: string): ProgramToolSource {
  return {
    async read(implementation) {
      const artifactPath = containedArtifact(appHome, implementation.executableArtifactRef)
      if (artifactPath === null)
        return failed('program-artifact-contained', implementation.executableArtifactRef)
      let source: string
      try {
        source = readFileSync(artifactPath, 'utf8')
      } catch (error) {
        return failed(
          'program-artifact-readable',
          error instanceof Error ? error.message : String(error),
        )
      }
      if (sha256Hex(source) !== implementation.executableDigest)
        return failed('program-artifact-digest', 'artifact digest mismatch')
      if (implementation.parameterValuesRef === null)
        return { kind: 'ok', source, parameterValuesJson: '{}' }
      const parameterPath = containedArtifact(appHome, implementation.parameterValuesRef)
      if (parameterPath === null)
        return failed('program-parameter-artifact-contained', implementation.parameterValuesRef)
      try {
        return {
          kind: 'ok',
          source,
          parameterValuesJson: JSON.stringify(
            parameterValuesSchema.parse(JSON.parse(readFileSync(parameterPath, 'utf8')) as unknown),
          ),
        }
      } catch (error) {
        return failed(
          'program-parameter-artifact-readable',
          error instanceof Error ? error.message : String(error),
        )
      }
    },
  }
}
