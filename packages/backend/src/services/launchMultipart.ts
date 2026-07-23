// RFC-218 T7 — shared multipart-launch skeleton. Extracted from
// routes/tasks.ts `handleMultipartTaskStart` (RFC-020/107/165 lineage) so the
// single-agent launch route (`POST /api/agents/:id/tasks`) binds upload
// files through the SAME parsing / field-grammar / validation / packing code
// as the workflow route instead of a second copy (dedup principle).
//
// Split of responsibilities:
//   • parseMultipartLaunch — form → { payloadJson, files } (payload field +
//     `files[<key>][]` grammar; defs-agnostic).
//   • assertUploadFilesMatchDefs — files ⊆ declared upload inputs.
//   • collectUploadInputDefs — WorkflowInput[] → validated UploadInputDef map.
//   • resolveUploadLimits — settings → UploadLimits.
//   • attachWorkspaceCleanupToMultipartError — keep the upload failure primary
//     when reclaiming the not-yet-owned workspace also fails.

import { UploadInputSchema, type WorkflowInput } from '@agent-workflow/shared'
import { loadConfig } from '@/config'
import {
  DEFAULT_UPLOAD_LIMITS,
  type UploadFile,
  type UploadInputDef,
  type UploadLimits,
} from '@/services/upload'
import type { WorkspaceCleanupReport } from '@/services/task'
import { DomainError, ValidationError } from '@/util/errors'

/** Match `files[<key>][]` field names; allowed keys mirror WorkflowInput.key. */
const UPLOAD_FIELD_RE = /^files\[([A-Za-z0-9_-]+)\]\[\]$/

/**
 * A bound-but-not-yet-buffered file part. Bytes are copied out of the form
 * only AFTER the caller has validated the target + input keys
 * (`bufferUploadParts`) — copying first would let any `tasks:launch` caller
 * force a second in-memory copy of arbitrarily large parts on a request that
 * must be rejected anyway (impl-gate P2-4).
 */
export interface MultipartFilePart {
  inputKey: string
  filename: string
  declaredMime: string
  blob: Blob
}

export interface ParsedMultipartLaunch {
  payloadJson: unknown
  parts: MultipartFilePart[]
}

/**
 * Parse a multipart launch request: pull the JSON `payload` field and bind
 * every `files[<key>][]` part (WITHOUT buffering bytes). Field-grammar errors
 * throw here; key-vs-defs membership and byte copies happen in
 * `bufferUploadParts` because only the caller knows its defs.
 */
export async function parseMultipartLaunch(req: Request): Promise<ParsedMultipartLaunch> {
  let form: Awaited<ReturnType<typeof req.formData>>
  try {
    form = await req.formData()
  } catch (err) {
    throw new ValidationError(
      'task-multipart-invalid',
      `failed to parse multipart body: ${(err as Error).message}`,
    )
  }

  const payloadField = form.get('payload')
  if (payloadField === null) {
    throw new ValidationError(
      'task-multipart-payload-missing',
      'multipart body must include a "payload" field with the launch JSON',
    )
  }
  const payloadText = typeof payloadField === 'string' ? payloadField : await payloadField.text()
  let payloadJson: unknown
  try {
    payloadJson = JSON.parse(payloadText)
  } catch (err) {
    throw new ValidationError(
      'task-multipart-payload-invalid',
      `payload field is not valid JSON: ${(err as Error).message}`,
    )
  }

  const parts: MultipartFilePart[] = []
  // Cast: bun's undici FormData type narrows to [string, string]; the real
  // value can be a File too — that's what we actually receive at runtime.
  const entries = form.entries() as unknown as Iterable<[string, string | File]>
  for (const [fieldName, value] of entries) {
    if (fieldName === 'payload') continue
    const m = UPLOAD_FIELD_RE.exec(fieldName)
    if (m === null) {
      throw new ValidationError(
        'task-multipart-unknown-field',
        `unexpected multipart field '${fieldName}'; expected 'payload' or 'files[<key>][]'`,
      )
    }
    if (typeof value === 'string') {
      throw new ValidationError(
        'task-multipart-string-not-file',
        `field '${fieldName}' must carry a file, got string`,
      )
    }
    // bun parses a part whose Content-Disposition carries `filename=""` (a
    // browser Blob that was never named) as a File whose `.name` is
    // `undefined`, NOT ''. Treat both empty and missing names as unnamed so we
    // don't hand a non-string filename to sanitizeFilename.
    parts.push({
      inputKey: m[1]!,
      filename: value.name ? value.name : 'upload.bin',
      declaredMime: value.type,
      blob: value,
    })
  }
  return { payloadJson, parts }
}

/**
 * Membership-check every bound part against the declared upload inputs, THEN
 * copy bytes out (in that order — see MultipartFilePart). Throws
 * `task-multipart-unknown-input` before a single byte is duplicated.
 */
export async function bufferUploadParts(
  parts: readonly MultipartFilePart[],
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
 * Extract upload-kind input declarations. Each one must pass UploadInputSchema
 * (strict-on-write) — anything that snuck past a save path with a bad
 * targetDir is rejected here too. Works for authored workflow inputs and for
 * RFC-218 derived agent-port inputs alike.
 */
export function collectUploadInputDefs(
  inputs: readonly WorkflowInput[],
): Map<string, UploadInputDef> {
  const out = new Map<string, UploadInputDef>()
  for (const inp of inputs) {
    if (inp.kind !== 'upload') continue
    const parsed = UploadInputSchema.safeParse(inp)
    if (!parsed.success) {
      throw new ValidationError(
        'upload-input-invalid',
        `workflow input '${inp.key}' (kind=upload) is malformed`,
        { issues: parsed.error.issues },
      )
    }
    const def: UploadInputDef = {
      key: parsed.data.key,
      targetDir: parsed.data.targetDir,
    }
    if (parsed.data.accept !== undefined) def.accept = parsed.data.accept
    if (parsed.data.maxFileSize !== undefined) def.maxFileSize = parsed.data.maxFileSize
    if (parsed.data.minCount !== undefined) def.minCount = parsed.data.minCount
    if (parsed.data.maxCount !== undefined) def.maxCount = parsed.data.maxCount
    out.set(def.key, def)
  }
  return out
}

/**
 * RFC-020: read `uploadLimits` from settings, falling back to defaults. Kept
 * narrow so the multipart handlers stay declarative.
 */
export function resolveUploadLimits(configPath: string): UploadLimits {
  try {
    const cfg = loadConfig(configPath)
    const u = cfg.uploadLimits
    if (u !== undefined) {
      return {
        perFile: u.perFile,
        perRequest: u.perRequest,
        perCount: u.perCount,
      }
    }
  } catch {
    // unreadable config → defaults
  }
  return { ...DEFAULT_UPLOAD_LIMITS }
}

/**
 * Keep the upload failure as the primary API error even when reclaiming its
 * not-yet-owned workspace also fails. The cleanup report is recovery metadata,
 * not a reason to erase the actionable upload code/status/details.
 */
export function attachWorkspaceCleanupToMultipartError(
  error: unknown,
  report: WorkspaceCleanupReport,
): DomainError {
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
