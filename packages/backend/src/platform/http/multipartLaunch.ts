// RFC-218 T7 — the multipart launch envelope. Extracted from routes/tasks.ts
// `handleMultipartTaskStart` (RFC-020/107/165 lineage) so the single-agent
// launch route (`POST /api/agents/:id/tasks`) binds upload files through the
// SAME parsing / field grammar as the workflow route (`POST /api/tasks`)
// instead of a second copy (dedup principle).
//
// RFC-445: the envelope is HTTP transport shared by both launch entries, so it
// lives in platform/http. The defs-aware steps that follow it (membership check
// before buffering, upload declaration extraction, limits, cleanup decoration)
// belong to task-execution.
//
//   • parseMultipartLaunch — form → { payloadJson, parts } (payload field +
//     `files[<key>][]` grammar; defs-agnostic).

import { ValidationError } from '@/util/errors'

const UPLOAD_FIELD_PREFIX = 'files['
const UPLOAD_FIELD_SUFFIX = '][]'

/**
 * Decode the `files[<key>][]` envelope without narrowing `<key>` to ASCII.
 * WorkflowInput.key accepts every non-empty Unicode string; exact membership
 * against the target's declared upload inputs is checked before bytes are
 * buffered, so the multipart transport must preserve that key verbatim.
 */
function parseUploadFieldName(fieldName: string): string | undefined {
  if (!fieldName.startsWith(UPLOAD_FIELD_PREFIX) || !fieldName.endsWith(UPLOAD_FIELD_SUFFIX)) {
    return undefined
  }
  const inputKey = fieldName.slice(UPLOAD_FIELD_PREFIX.length, -UPLOAD_FIELD_SUFFIX.length)
  return inputKey.length > 0 ? inputKey : undefined
}

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
    const inputKey = parseUploadFieldName(fieldName)
    if (inputKey === undefined) {
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
    // don't hand a non-string filename to sanitizeUploadFilename.
    parts.push({
      inputKey,
      filename: value.name ? value.name : 'upload.bin',
      declaredMime: value.type,
      blob: value,
    })
  }
  return { payloadJson, parts }
}
