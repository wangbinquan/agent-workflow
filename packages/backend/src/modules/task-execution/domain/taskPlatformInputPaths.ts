// Trusted task-level platform input mounts.
//
// This grammar belongs to Task Execution: it is the durable, launch-frozen
// roster used by task snapshots and merge-back.  The legacy service path
// re-exports these operations for compatibility, but domain code never reaches
// back into `services/`.

import {
  PLATFORM_FUSION_DIR,
  PLATFORM_INPUTS_DIR,
  PLATFORM_PIPELINE_DIR,
} from '@agent-workflow/shared'

export const TASK_PLATFORM_INPUT_PATHS_MAX = 128
export const TASK_PLATFORM_INPUT_PATH_MAX_LENGTH = 512

const ALLOWED_ROOTS = [PLATFORM_INPUTS_DIR, PLATFORM_PIPELINE_DIR, PLATFORM_FUSION_DIR] as const

function canonicalPath(raw: string): string | null {
  const path = raw.normalize('NFC')
  if (
    path.length === 0 ||
    path.length > TASK_PLATFORM_INPUT_PATH_MAX_LENGTH ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes('\0')
  ) {
    return null
  }
  const segments = path.split('/')
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        [...segment].some((char) => {
          const cp = char.codePointAt(0) ?? 0
          return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029
        }),
    )
  ) {
    return null
  }
  return ALLOWED_ROOTS.some((root) => path.startsWith(`${root}/`)) ? path : null
}

/** Canonicalize, deduplicate and sort the immutable launch roster. */
export function normalizeTaskPlatformInputPaths(paths: readonly string[]): string[] | null {
  if (paths.length > TASK_PLATFORM_INPUT_PATHS_MAX) return null
  const out = new Set<string>()
  for (const raw of paths) {
    const path = canonicalPath(raw)
    if (path === null) return null
    out.add(path)
  }
  return [...out].sort()
}

/** Decode a persisted roster. Corrupt rows fail closed at the scheduler boundary. */
export function parseTaskPlatformInputPaths(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw === '') return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('task platform input path roster is not valid JSON')
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('task platform input path roster must be a string array')
  }
  const normalized = normalizeTaskPlatformInputPaths(value as string[])
  if (normalized === null) throw new Error('task platform input path roster is invalid')
  return normalized
}
