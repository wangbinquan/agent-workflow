// RFC-308 — the one repository-relative namespace for files created by the
// platform inside a task/fusion worktree. Keep this dependency-free: backend,
// frontend launch hints, and shared validators derive byte-identical paths.

export const PLATFORM_WORKSPACE_DIR = '.agent-workflow' as const

export const PLATFORM_WORKSPACE_SUBDIRS = {
  inputs: 'inputs',
  runs: 'runs',
  fusion: 'fusion',
  // RFC-310 T32 — pipeline evidence bundles（自建门禁大日志的只读物化区）。
  pipeline: 'pipeline',
} as const

export type PlatformWorkspaceKind = keyof typeof PLATFORM_WORKSPACE_SUBDIRS

export const PLATFORM_INPUTS_DIR = `${PLATFORM_WORKSPACE_DIR}/${PLATFORM_WORKSPACE_SUBDIRS.inputs}`
export const PLATFORM_RUNS_DIR = `${PLATFORM_WORKSPACE_DIR}/${PLATFORM_WORKSPACE_SUBDIRS.runs}`
export const PLATFORM_FUSION_DIR = `${PLATFORM_WORKSPACE_DIR}/${PLATFORM_WORKSPACE_SUBDIRS.fusion}`
export const PLATFORM_FUSION_MANIFEST = `${PLATFORM_FUSION_DIR}/result.json`
export const PLATFORM_PIPELINE_DIR = `${PLATFORM_WORKSPACE_DIR}/${PLATFORM_WORKSPACE_SUBDIRS.pipeline}`
/** RFC-310 — requirement bundles 固定落 `inputs/requirements/<bundleId>`。 */
export const PLATFORM_REQUIREMENTS_DIR = `${PLATFORM_INPUTS_DIR}/requirements`

/** requirement bundle 根：`.agent-workflow/inputs/requirements/<bundleId>`。 */
export function requirementBundlePath(bundleId: string, ...segments: readonly string[]): string {
  const base = `${PLATFORM_REQUIREMENTS_DIR}/${platformWorkspaceSegment(bundleId)}`
  if (segments.length === 0) return base
  return `${base}/${segments.map(platformWorkspaceSegment).join('/')}`
}

/** pipeline evidence 根：`.agent-workflow/pipeline/<bundleId>`。 */
export function pipelineBundlePath(bundleId: string, ...segments: readonly string[]): string {
  const base = `${PLATFORM_PIPELINE_DIR}/${platformWorkspaceSegment(bundleId)}`
  if (segments.length === 0) return base
  return `${base}/${segments.map(platformWorkspaceSegment).join('/')}`
}

/** One safe path segment; callers may not smuggle a second path or traversal. */
export function platformWorkspaceSegment(raw: string): string {
  const value = raw.normalize('NFC')
  if (
    value === '' ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    /^[A-Za-z]:/.test(value) ||
    [...value].some((char) => {
      const cp = char.codePointAt(0) ?? 0
      return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029
    })
  ) {
    throw new Error(`unsafe platform workspace segment: ${JSON.stringify(raw)}`)
  }
  return value
}

export function platformWorkspacePath(
  kind: PlatformWorkspaceKind,
  ...segments: readonly string[]
): string {
  const base = `${PLATFORM_WORKSPACE_DIR}/${PLATFORM_WORKSPACE_SUBDIRS[kind]}`
  if (segments.length === 0) return base
  return `${base}/${segments.map(platformWorkspaceSegment).join('/')}`
}

export function isPlatformWorkspacePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  return (
    normalized === PLATFORM_WORKSPACE_DIR || normalized.startsWith(`${PLATFORM_WORKSPACE_DIR}/`)
  )
}
