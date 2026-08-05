// RFC-258 §2.3 — the per-repo worktree snapshot digest that keys the SCIP
// index cache. Gate F-01: this is DELIBERATELY NOT the structural-diff
// `contentDigest` — that one hashes the SYMBOL MANIFEST (a body-only edit or a
// change in a file outside the diff leaves it unchanged), which would serve
// stale definitions/references. This digest covers HEAD + the porcelain status
// text + the CONTENT of every dirty/untracked file, so any byte-level worktree
// change invalidates.

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runGit } from '@/util/git'

/** Files reported dirty/untracked by `status --porcelain -z`. */
function dirtyPaths(porcelainZ: string): string[] {
  const out: string[] = []
  const records = porcelainZ.split('\u0000')
  for (let i = 0; i < records.length; i++) {
    const entry = records[i] ?? ''
    if (entry.length < 4) continue
    out.push(entry.slice(3))
    // R/C records are followed by a bare ORIG-path z-record — consume it here
    // so it is never mis-sliced as a status row (impl-gate P2-6).
    const x = entry[0]
    if (x === 'R' || x === 'C') i += 1
  }
  return out
}

export async function worktreeSnapshotDigest(worktreePath: string): Promise<string> {
  const head = (await runGit(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
  // -uall: an untracked DIRECTORY otherwise reports one `?? dir/` row and the
  // files inside it would never contribute content prints — a stale-graph
  // hole (impl-gate P0-3, the F-01 failure mode through a different door).
  const porcelain = (await runGit(worktreePath, ['status', '--porcelain', '-uall', '-z'])).stdout
  const h = createHash('sha256')
  h.update(head)
  h.update('\u0000')
  h.update(porcelain)
  for (const rel of dirtyPaths(porcelain)) {
    const abs = join(worktreePath, rel)
    try {
      const st = statSync(abs)
      if (!st.isFile()) continue
      h.update(rel)
      h.update('\u0000')
      // Content hash, not mtime: an editor rewriting identical bytes must not
      // churn the key, and a content change with a preserved mtime must.
      h.update(createHash('sha256').update(readFileSync(abs)).digest())
    } catch {
      // vanished mid-scan — the porcelain text (already hashed) captured it
    }
  }
  return h.digest('hex').slice(0, 16)
}
