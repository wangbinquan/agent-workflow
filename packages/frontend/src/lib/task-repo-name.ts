// RFC-192 (T1) — the /tasks list repo display name.
//
// Path-mode tasks show the workspace dir's basename. URL-mode tasks must NOT
// basename `repoPath` — that is the internal cache dir (`…/repos/{hash}-{slug}`,
// Codex 设计门 P2) — they derive the repo name from the REDACTED `repoUrl`
// (shared `redactGitUrl`, RFC-024/054: never render a raw URL). The title
// carries the full (redacted) source for hover.

import { redactGitUrl } from '@agent-workflow/shared'

export interface TaskRepoDisplay {
  name: string
  title: string
}

/** Last non-empty `/`-segment; the input itself when it has none. */
function pathBasename(p: string): string {
  const segs = p.split('/').filter((s) => s !== '')
  return segs.length > 0 ? segs[segs.length - 1]! : p
}

/** Repo name out of a (redacted) git URL: last path segment, `.git` stripped.
 *  Handles scp-style `git@host:org/repo.git` via the `:` separator. */
function urlRepoName(redacted: string): string | null {
  const noHash = redacted.split(/[?#]/, 1)[0]!.replace(/\/+$/, '')
  const seg = noHash.split(/[/:]/).filter((s) => s !== '')
  const last = seg.length > 0 ? seg[seg.length - 1]! : ''
  const name = last.endsWith('.git') ? last.slice(0, -4) : last
  return name === '' ? null : name
}

export function taskRepoDisplayName(row: {
  repoPath: string
  repoUrl: string | null
}): TaskRepoDisplay {
  if (row.repoUrl != null && row.repoUrl !== '') {
    const redacted = redactGitUrl(row.repoUrl)
    const name = urlRepoName(redacted)
    if (name !== null) return { name, title: redacted }
    // Unparsable URL: fall back to the cache-dir basename (an internal name
    // beats a blank cell); the title stays the redacted source.
    return { name: pathBasename(row.repoPath), title: redacted }
  }
  return { name: pathBasename(row.repoPath), title: row.repoPath }
}
