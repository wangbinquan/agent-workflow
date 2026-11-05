// RFC-218 T7 / RFC-445 — the launch use case's upload steps after the
// multipart envelope is parsed (`platform/http/multipartLaunch`).
//
//   • bufferUploadParts — files ⊆ declared upload inputs, THEN copy bytes.
//   • attachWorkspaceCleanupToMultipartError — keep the upload failure primary
//     when reclaiming the not-yet-owned workspace also fails.
//
// Upload declarations are extracted by `collectUploadInputDefs`
// (`domain/uploads`); limits from settings by `resolveUploadLimits`
// (`infrastructure/local/fileTaskLaunchConfiguration`).

import { DomainError, ValidationError } from '@/util/errors'
import type { UploadFile, UploadInputDef } from '../domain/uploads'
import type { TaskRouteMultipartFilePart } from '../public/commands'

/**
 * Membership-check every bound part against the declared upload inputs, THEN
 * copy bytes out (in that order — see `MultipartFilePart` in
 * platform/http/multipartLaunch). Throws `task-multipart-unknown-input`
 * before a single byte is duplicated.
 */
export async function bufferUploadParts(
  parts: readonly TaskRouteMultipartFilePart[],
  defs: ReadonlyMap<string, UploadInputDef>,
): Promise<UploadFile[]> {
  for (const p of parts) {
    if (!defs.has(p.inputKey)) {
      throw new ValidationError(
        'task-multipart-unknown-input',
        `multipart files target unknown upload input '${p.inputKey}'`,
      )
    }
  }
  const files: UploadFile[] = []
  for (const p of parts) {
    files.push({
      inputKey: p.inputKey,
      filename: p.filename,
      declaredMime: p.declaredMime,
      bytes: new Uint8Array(await p.blob.arrayBuffer()),
    })
  }
  return files
}

/**
 * Keep the upload failure as the primary API error even when reclaiming its
 * not-yet-owned workspace also fails. The cleanup report is recovery metadata,
 * not a reason to erase the actionable upload code/status/details.
 */
export function attachWorkspaceCleanupToMultipartError<
  Report extends { readonly complete: boolean },
>(error: unknown, report: Report): DomainError {
  const primary =
    error instanceof DomainError
      ? error
      : new ValidationError(
          'task-upload-failed',
          `failed to land uploads into worktree: ${error instanceof Error ? error.message : String(error)}`,
        )
  if (report.complete) return primary
  const details =
    typeof primary.details === 'object' &&
    primary.details !== null &&
    !Array.isArray(primary.details)
      ? { ...primary.details, workspaceCleanup: report }
      : { causeDetails: primary.details, workspaceCleanup: report }
  return new DomainError(primary.code, primary.message, primary.status, details)
}
