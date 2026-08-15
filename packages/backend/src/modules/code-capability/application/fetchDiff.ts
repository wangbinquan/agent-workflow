// RFC-304 §6 — `fetch-diff`, executed.
//
// Produces the round's anchoring baseline: the host's own diff, normalized,
// plus the hunks every finding is later placed against.
//
// The response cap is raised here rather than left at the client default. The
// default (256 KiB) is sized for the small JSON bodies most actions return; a
// diff is the one read that routinely exceeds it, and an exceeded cap is
// refused rather than parsed, so leaving the default in place would turn every
// medium-sized MR into "this MR is too large to review".

import { parseDiffHunks } from '@/modules/code-capability/domain/diffHunks'
import type { DiffHunk } from '@/modules/code-capability/domain/anchorResolve'
import {
  omittedFiles,
  readMrDiffResponse,
  toUnifiedDiff,
  type FileDiff,
} from '@/modules/code-capability/domain/mrDiffNormalize'
import { apiProjectAddress, type RoundTarget } from '@/modules/code-capability/domain/resolveTarget'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'

/** 4 MiB. Large enough for a substantial MR, small enough to stay a bound. */
export const DIFF_RESPONSE_MAX_BYTES = 4 * 1024 * 1024

export type FetchDiffResult =
  | {
      readonly ok: true
      readonly files: readonly FileDiff[]
      /** The reassembled unified diff — the artifact anchoring is judged against. */
      readonly unifiedDiff: string
      readonly hunks: readonly DiffHunk[]
      /** Changed files with no readable patch, for the overview comment. */
      readonly omitted: ReadonlyArray<{ path: string; omission: 'binary' | 'too-large' }>
    }
  | { readonly ok: false; readonly reason: string; readonly message: string }

export async function fetchDiff(input: {
  codeHost: CodeHostPort
  target: RoundTarget
  maxResponseBytes?: number
}): Promise<FetchDiffResult> {
  const { codeHost, target } = input

  // The API address, not the identity: GitHub's `/repos/` route does not accept
  // the numeric repository id that the work item is keyed by.
  const project = apiProjectAddress(target)
  if (!project.ok) return { ok: false, reason: 'unaddressable', message: project.message }

  const result = await codeHost.call({
    action: 'mr.diff',
    params: { project: project.value, mr: target.anchorId },
    maxResponseBytes: input.maxResponseBytes ?? DIFF_RESPONSE_MAX_BYTES,
  })

  const read = readMrDiffResponse(target.provider, result)
  if (!read.ok) return { ok: false, reason: read.reason, message: read.message }

  const unifiedDiff = toUnifiedDiff(read.files)
  return {
    ok: true,
    files: read.files,
    unifiedDiff,
    hunks: parseDiffHunks(unifiedDiff),
    omitted: omittedFiles(read.files),
  }
}
