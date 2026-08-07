// RFC-199 B2 — terminal local-draft export.
//
// Deleted/inaccessible drafts cannot trust a live server export. Build the
// artifact from the in-memory composite snapshot and mark the filename so it
// can never be mistaken for a confirmed persisted revision.

import {
  normalizeResourceDisplayName,
  stringifyWorkflowYamlDocument,
  workflowDefinitionToNameSelectors,
  type WorkflowDraftSnapshot,
} from '@agent-workflow/shared'

/**
 * RFC-264 — keep the workflow's own characters in the download name. The old
 * rule folded everything outside `[a-zA-Z0-9_-]` to `-`, so every Chinese-named
 * workflow downloaded as the bare fallback `workflow.yaml`. Only characters a
 * file system actually rejects are replaced; `<a download>` carries UTF-8 fine
 * (this path never touches an HTTP header, so RFC 5987 does not apply).
 */
function safeDownloadBaseName(name: string): string {
  const cleaned = normalizeResourceDisplayName(name)
    .replace(/[/\\:*?"<>|]/g, '-') // POSIX separator + the Windows reserved set
    .replace(/\p{Cc}/gu, '-')
    .replace(/[. ]+$/, '') // Windows rejects a trailing dot or space
  return cleaned === '' ? 'workflow' : cleaned
}

export interface WorkflowLocalDraftExport {
  filename: string
  yaml: string
}

export function buildWorkflowLocalDraftExport(
  snapshot: WorkflowDraftSnapshot,
): WorkflowLocalDraftExport {
  return {
    filename: `${safeDownloadBaseName(snapshot.name)}-unsaved.yaml`,
    yaml: stringifyWorkflowYamlDocument({
      ...snapshot,
      definition: workflowDefinitionToNameSelectors(snapshot.definition),
    }),
  }
}

export function downloadWorkflowLocalDraft(snapshot: WorkflowDraftSnapshot): void {
  const artifact = buildWorkflowLocalDraftExport(snapshot)
  downloadWorkflowBlob(new Blob([artifact.yaml], { type: 'application/yaml' }), artifact.filename)
}

/** Download an authenticated exact-revision export returned by the daemon. */
export function downloadWorkflowServerExport(blob: Blob, workflowName: string): void {
  downloadWorkflowBlob(blob, `${safeDownloadBaseName(workflowName)}.yaml`)
}

function downloadWorkflowBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
