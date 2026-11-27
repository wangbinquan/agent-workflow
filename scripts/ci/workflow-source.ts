// RFC-615 / RFC-627: timing provenance follows the source commit's actual calculation
// workflow, including historical monolithic/13-job CI runs and backend-full-nightly.
// Zero third-party dependencies: runs directly under Bun in no-install CI jobs.
import { YAML } from 'bun'

export const CI_WORKFLOW_PATH = '.github/workflows/ci-work.yml'
export const BACKEND_FULL_NIGHTLY_PATH = '.github/workflows/backend-full-nightly.yml'

export const LEGACY_CI_WORK_JOB_IDS = [
  'lint',
  'test-backend',
  'test-backend-postgresql',
  'test-frontend',
  'scans',
  'perf',
  'docs',
  'build-binary',
  'build-binary-macos',
  'build-binary-windows',
  'e2e',
  'e2e-macos',
  'e2e-windows',
] as const

export const CI_WORK_JOB_IDS = [
  'lint',
  'test-backend',
  'test-backend-postgresql',
  'test-backend-migration',
  'test-frontend',
  'scans',
  'perf',
  'docs',
  'build-binary',
  'build-binary-macos',
  'build-binary-windows',
  'e2e',
  'e2e-macos',
  'e2e-windows',
] as const

export function resolveCiWorkSource(readSourceFile: (path: string) => string): {
  path: string
  workflow: string
} {
  const path = '.github/workflows/ci.yml'
  const entry = readSourceFile(path)
  const parent = YAML.parse(entry) as { jobs?: Record<string, { uses?: unknown }> } | null
  const legacy = parent?.jobs?.['test-backend'] !== undefined
  const call = parent?.jobs?.['full-ci']
  if (legacy && call) throw new Error('Mixed monolithic and reusable CI source')
  if (legacy) return { path, workflow: entry }
  if (call?.uses !== `./${CI_WORKFLOW_PATH}`)
    throw new Error('Unknown source CI calculation workflow')
  const workflow = readSourceFile(CI_WORKFLOW_PATH)
  const calculation = YAML.parse(workflow) as {
    on?: Record<string, unknown>
    jobs?: Record<string, unknown>
  } | null
  if (
    !calculation?.on ||
    JSON.stringify(Object.keys(calculation.on)) !== JSON.stringify(['workflow_call'])
  )
    throw new Error('Source calculation workflow must be reusable only')
  const names = Object.keys(calculation.jobs ?? {}).sort()
  const matchesCurrent = JSON.stringify(names) === JSON.stringify([...CI_WORK_JOB_IDS].sort())
  const matchesLegacy = JSON.stringify(names) === JSON.stringify([...LEGACY_CI_WORK_JOB_IDS].sort())
  if (!matchesCurrent && !matchesLegacy)
    throw new Error('Source calculation workflow has an unknown job population')
  return { path: CI_WORKFLOW_PATH, workflow }
}

export function resolveNightlyBackendSource(readSourceFile: (path: string) => string): {
  path: string
  workflow: string
} {
  const workflow = readSourceFile(BACKEND_FULL_NIGHTLY_PATH)
  const parsed = YAML.parse(workflow) as {
    on?: Record<string, unknown>
    jobs?: Record<string, unknown>
  } | null
  if (!parsed?.on || !('schedule' in parsed.on) || !('workflow_dispatch' in parsed.on))
    throw new Error('Nightly backend workflow must declare schedule and workflow_dispatch triggers')
  const names = Object.keys(parsed.jobs ?? {}).sort()
  if (JSON.stringify(names) !== JSON.stringify(['test-backend-full']))
    throw new Error('Nightly backend workflow has an unknown job population')
  return { path: BACKEND_FULL_NIGHTLY_PATH, workflow }
}
