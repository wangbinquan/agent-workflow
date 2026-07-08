// RFC-151 PR-1 — structured import warnings for AgentImportDialog.
//
// `parseAgentMarkdown` (shared) reports problems as a bare string[] where a
// fatal YAML failure is encoded as a `yaml-parse-failed: <detail>` prefix.
// The dialog used to re-run `startsWith('yaml-parse-failed:')` at three
// consumption sites (gating Apply, the error banner, the warning list) — a
// stringly-typed protocol. This normalizer lifts the strings into
// `{code, message, blocking}` records once, at the parse boundary; consumers
// read structure only. The wire (shared parser output) is unchanged (D5).

export interface AgentImportWarning {
  code: 'yaml-parse-failed' | 'warning'
  message: string
  blocking: boolean
}

export const YAML_PARSE_FAILED_PREFIX = 'yaml-parse-failed:'

export function structureImportWarnings(warnings: readonly string[]): AgentImportWarning[] {
  return warnings.map((w) =>
    w.startsWith(YAML_PARSE_FAILED_PREFIX)
      ? // message keeps the full original string (prefix included) so the
        // dialog banner renders byte-identically to the pre-lift UI.
        { code: 'yaml-parse-failed', message: w, blocking: true }
      : { code: 'warning', message: w, blocking: false },
  )
}
