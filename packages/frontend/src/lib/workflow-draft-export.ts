// RFC-199 B2 — terminal local-draft export.
//
// Deleted/inaccessible drafts cannot trust a live server export. Build the
// artifact from the in-memory composite snapshot and mark the filename so it
// can never be mistaken for a confirmed persisted revision.

import {
  stringifyWorkflowYamlDocument,
  workflowDefinitionToNameSelectors,
  type WorkflowDraftSnapshot,
} from '@agent-workflow/shared'

export interface WorkflowLocalDraftExport {
  filename: string
  yaml: string
}

export function buildWorkflowLocalDraftExport(
  snapshot: WorkflowDraftSnapshot,
): WorkflowLocalDraftExport {
  const safeName = snapshot.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return {
    filename: `${safeName === '' ? 'workflow' : safeName}-unsaved.yaml`,
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
  const safeName = workflowName.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  downloadWorkflowBlob(blob, `${safeName === '' ? 'workflow' : safeName}.yaml`)
}

function downloadWorkflowBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
