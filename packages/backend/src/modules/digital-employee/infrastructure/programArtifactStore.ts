import { canonicalJson } from '@agent-workflow/shared'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'
import { z } from 'zod'

import type { ProgramArtifactPort } from '../composition/required-ports'
import { sha256Hex } from '@/util/hash'
import { realpathInside, safeJoin } from '@/util/safePath'

const EXTENSION = {
  bash: 'sh',
  node: 'mjs',
  python: 'py',
} as const

const parameterValuesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))

function putImmutable(root: string, relativePath: string, body: string): void {
  const absolute = join(root, relativePath)
  if (existsSync(absolute)) return
  mkdirSync(dirname(absolute), { recursive: true })
  const temporary = `${absolute}.tmp-${ulid()}`
  writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try {
    renameSync(temporary, absolute)
  } catch (error) {
    if (!existsSync(absolute)) throw error
  }
}

export function createProgramArtifactStore(appHome: string): ProgramArtifactPort {
  return {
    async put(input) {
      const executableDigest = sha256Hex(input.source)
      const executableArtifactRef = `digital-employee/program-tools/${executableDigest}.${EXTENSION[input.runtimeKind]}`
      putImmutable(appHome, executableArtifactRef, input.source)

      let parameterValuesRef: string | null = null
      if (input.parameterValues !== null && Object.keys(input.parameterValues).length > 0) {
        const body = canonicalJson(input.parameterValues)
        const digest = sha256Hex(body)
        parameterValuesRef = `digital-employee/program-tools/${digest}.params.json`
        putImmutable(appHome, parameterValuesRef, `${body}\n`)
      }

      return { executableArtifactRef, executableDigest, parameterValuesRef }
    },
    read(input) {
      try {
        const executablePath = realpathInside(
          appHome,
          safeJoin(appHome, input.executableArtifactRef),
        )
        const source = readFileSync(executablePath, 'utf8')
        if (sha256Hex(source) !== input.executableDigest) return null

        if (input.parameterValuesRef === null) return { source, parameterValues: null }
        const parameterPath = realpathInside(appHome, safeJoin(appHome, input.parameterValuesRef))
        const parsed = parameterValuesSchema.safeParse(
          JSON.parse(readFileSync(parameterPath, 'utf8')) as unknown,
        )
        return parsed.success ? { source, parameterValues: parsed.data } : null
      } catch {
        return null
      }
    },
  }
}
