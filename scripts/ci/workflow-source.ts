// RFC-615: timing provenance follows the source commit's actual calculation
// workflow, including historical monolithic CI runs. No current-HEAD fallback.
import { YAML } from 'bun'

export const CI_WORKFLOW_PATH = '.github/workflows/ci-work.yml'
export const CI_WORK_JOB_IDS = [
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
  const names = Object.keys(calculation.jobs ?? {})
  if (JSON.stringify(names.sort()) !== JSON.stringify([...CI_WORK_JOB_IDS].sort()))
    throw new Error('Source calculation workflow has an unknown job population')
  return { path: CI_WORKFLOW_PATH, workflow }
}
