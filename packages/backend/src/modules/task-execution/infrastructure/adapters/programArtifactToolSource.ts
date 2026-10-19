// RFC-370 §10 V19 — a program tool source over the digital employee's selected
// program artifact store (platform objects when hosted). Structural: Task
// Execution does not depend on the digital employee module; bootstrap hands
// the store in.
import type { ProgramToolSource } from '../../application/ports/scriptFixture'

interface ProgramArtifact {
  readonly source: string
  readonly parameterValues: Readonly<Record<string, string | number | boolean>> | null
}

export interface ProgramArtifactReader {
  read(input: {
    readonly runtimeKind: 'bash' | 'node' | 'python'
    readonly executableArtifactRef: string
    readonly executableDigest: string
    readonly parameterValuesRef: string | null
  }): ProgramArtifact | null | Promise<ProgramArtifact | null>
}

export function createArtifactProgramToolSource(store: ProgramArtifactReader): ProgramToolSource {
  return {
    async read(implementation) {
      // The implementation reaches the store as the authoring path hands it
      // over (the store reads the fields it needs).
      const program = await store.read(implementation)
      // The store answers null for an absent object, a digest mismatch and
      // unreadable parameter values alike.
      if (program === null)
        return {
          kind: 'failed',
          check: {
            code: 'program-artifact-readable',
            ok: false,
            detail: 'the program artifact is unavailable or does not match its digest',
          },
        }
      return {
        kind: 'ok',
        source: program.source,
        parameterValuesJson: JSON.stringify(program.parameterValues ?? {}),
      }
    },
  }
}
