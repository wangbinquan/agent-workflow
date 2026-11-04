// RFC-438 — 运行期 heal 自 RFC-395 II-b 起由 epoch-2 转换规则 `integration/boot-scheduled-payload` 取代，生产代码零调用；
// 按 RFC-424 先例迁入用例辅助，只用来造降级行、复核旧修复规则。原位置 services/scheduledTasks.ts。
import { existsSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { rejectRetiredStartTaskKeys } from '@agent-workflow/shared'

import type { Row, ScheduledTaskOperations } from '@/modules/integration/application/scheduledTasks'
import { runGit } from '@/util/git'

/**
 * RFC-165 (§9): one-shot boot healer — rewrite stored path-mode launch
 * payloads to their faithful `file://` form. Runs after migrations and BEFORE
 * the HTTP server starts serving (and before the scheduler ticker), so both
 * read paths and fires only ever see healed rows.
 *
 * Strategy (F19): `pathToFileURL(realpath(dir))` preserves the LOCAL repo
 * exactly (unpushed branches included — the cached mirror clones from the
 * path itself), unlike an origin-URL rewrite which drops anything unpushed.
 *   * dir exists and is a git repo → rewrite `{repoPath, baseBranch}` →
 *     `{repoUrl: file://…, ref: baseBranch}` (top level and each repos[] row);
 *     drop `fetchBeforeLaunch` (false/absent only). Git-ness is probed via
 *     `git rev-parse --git-dir` (a bare repo / worktree subdir has no `.git`
 *     child yet was perfectly launchable in path mode).
 *   * `fetchBeforeLaunch: true`     → DISABLE + lastError
 *     'rfc165-fetch-semantic-review' — the old semantics ("refresh the local
 *     repo's origin/* before launch") have no file:// equivalent; the user
 *     must confirm a URL choice and re-save. Never silently converted.
 *   * `baseBranch` naming a REMOTE-TRACKING ref (`origin/x`, `refs/remotes/…`)
 *     → DISABLE + lastError 'rfc165-remote-tracking-ref'. In the file clone
 *     that string resolves against the CLONE's own origin (= the source's
 *     local branches), not the source's refs/remotes/* — silently launching
 *     a different commit is exactly what F19 forbids.
 *   * dir missing / not a git repo → DISABLE + lastError
 *     'rfc165-local-path-retired'.
 * Idempotent: healed payloads carry no `repoPath`; already-disabled rfc165-*
 * rows are skipped.
 */
export async function healScheduledLaunchPayloads(
  operations: ScheduledTaskOperations,
): Promise<{ scanned: number; converted: number; disabled: number }> {
  const rows = await operations.persistence.list()
  let converted = 0
  let disabled = 0
  const now = Date.now()

  const disable = async (row: Row, error: string): Promise<void> => {
    await operations.persistence.updateHealedPayload({
      id: row.id,
      disableError: error,
      updatedAt: now,
    })
    disabled += 1
  }
  // Resolve a legacy path to the CLONABLE git root (P2 review fixes ×2):
  //   * a `.git`-child check missed bare repos / worktree subdirs → probe with
  //     git itself;
  //   * a subdir inside a worktree passes `rev-parse` but `git clone
  //     file:///repo/subdir` fails (not a repo root) → canonicalize to
  //     `--show-toplevel`, falling back to the absolute git dir for bare
  //     repos (which have no worktree).
  // Returns null when the path isn't inside any git repo.
  const resolveGitRoot = async (p: string): Promise<string | null> => {
    if (!existsSync(p)) return null
    try {
      const top = await runGit(p, ['rev-parse', '--show-toplevel'])
      if (top.exitCode === 0 && top.stdout.trim() !== '') return top.stdout.trim()
      const bare = await runGit(p, ['rev-parse', '--is-bare-repository'])
      if (bare.exitCode === 0 && bare.stdout.trim() === 'true') {
        const gd = await runGit(p, ['rev-parse', '--absolute-git-dir'])
        if (gd.exitCode === 0 && gd.stdout.trim() !== '') return gd.stdout.trim()
      }
      return null
    } catch {
      return null
    }
  }
  const toFileUrl = (p: string): string => pathToFileURL(realpathSync(p)).href
  // A remote-tracking ref cannot be carried into the file clone faithfully —
  // the clone's `origin/x` points at the SOURCE's local x, not the source's
  // own refs/remotes/origin/x (P1 review fix: disable instead of drifting).
  // Spelling alone is NOT enough (P2 review fix): a real local branch or tag
  // literally named `origin/topic` is legitimate — verify against the source
  // repo and only treat the ref as remote-tracking when no local ref claims
  // that exact name.
  const isRemoteTrackingRef = async (root: string, ref: string): Promise<boolean> => {
    const spelledRemote =
      ref.startsWith('origin/') || ref.startsWith('refs/remotes/') || ref.startsWith('remotes/')
    if (!spelledRemote) return false
    try {
      const local = await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`])
      if (local.exitCode === 0) return false
      const tag = await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${ref}`])
      if (tag.exitCode === 0) return false
    } catch {
      /* fall through to remote-tracking */
    }
    return true
  }

  for (const row of rows) {
    if (!row.enabled && (row.lastError ?? '').startsWith('rfc165-')) continue
    let payload: unknown
    try {
      payload = JSON.parse(row.launchPayload)
    } catch {
      continue // corrupt JSON → tolerant read surfaces it; not a path-heal target
    }
    if (typeof payload !== 'object' || payload === null) continue
    if (rejectRetiredStartTaskKeys(payload) === null) continue // already v2-clean
    const body = payload as Record<string, unknown>

    // RFC-320: unlike path-mode payloads, a stored client-owned Git identity
    // needs no semantic conversion. Drop it; the schedule owner is resolved at
    // each actual fire. This also makes rows injected after the SQL migration
    // self-heal instead of being misclassified as path migrations.
    const hadClientGitIdentity = 'gitUserName' in body || 'gitUserEmail' in body
    delete body['gitUserName']
    delete body['gitUserEmail']
    if (hadClientGitIdentity && rejectRetiredStartTaskKeys(body) === null) {
      await operations.persistence.updateHealedPayload({
        id: row.id,
        launchPayload: JSON.stringify(body),
        updatedAt: now,
      })
      converted += 1
      continue
    }

    if (body['fetchBeforeLaunch'] === true) {
      await disable(
        row,
        'rfc165-fetch-semantic-review: fetchBeforeLaunch has no file:// equivalent — pick a repo source and re-save',
      )
      continue
    }

    // RFC-248: `repos[]` 退役后，存量的**多仓** payload 到这里是无法自愈的——
    // 框架没法替用户凭空造一个仓库组（挂载布局、ref、只读是人的设计意图，不是
    // 能从两个 URL 推出来的东西）。
    //
    // 不处理的后果不是「保持现状」，而是一条**反复失败的启用中计划**：`repos`
    // 现在会让 `rejectRetiredStartTaskKeys` 返回非 null，于是每轮扫描都把它当
    // 「待转换」捡起来、删掉几个别的键、写回、计一次 converted，而 `repos` 还
    // 在——下一轮再来一遍，永远清不干净；与此同时计划照旧到点触发、每次 422。
    // 这正是设计第 10 行要防的烂账，只是从存量 payload 这一侧进来的。
    //
    // 单条 `repos` 是可以自愈的（它语义上就是单仓），下面统一在末尾摊平；
    // 两条及以上只能停发并说清怎么改。
    {
      const rawRepos = body['repos']
      if (Array.isArray(rawRepos) && rawRepos.length > 1) {
        await disable(
          row,
          `rfc248-multi-repo-retired: inline repos[] is retired (${rawRepos.length} entries); ` +
            'create a repo group and re-save this schedule with repoGroupId',
        )
        continue
      }
    }

    // Pair each legacy path with the baseBranch that would ride into `ref`,
    // so both the root canonicalization and the remote-tracking check run
    // against the RIGHT source repo.
    const pairs: Array<{ path: string; ref: string | undefined }> = []
    if (typeof body['repoPath'] === 'string') {
      pairs.push({
        path: body['repoPath'] as string,
        ref: typeof body['baseBranch'] === 'string' ? (body['baseBranch'] as string) : undefined,
      })
    }
    const repos = Array.isArray(body['repos'])
      ? (body['repos'] as Array<Record<string, unknown>>)
      : []
    for (const r of repos) {
      if (r !== null && typeof r === 'object' && typeof r['repoPath'] === 'string') {
        pairs.push({
          path: r['repoPath'] as string,
          ref: typeof r['baseBranch'] === 'string' ? (r['baseBranch'] as string) : undefined,
        })
      }
    }
    if (pairs.length === 0) {
      // Retired keys present but no path value (e.g. stray baseBranch) — just
      // strip them so the payload becomes v2-clean.
      delete body['baseBranch']
      delete body['fetchBeforeLaunch']
      // RFC-248: 到这里 `repos` 至多一条（多条已在上面停发）。把它摊平成顶层
      // 单仓字段再删除——**必须删**，留着它 payload 永远不是 v2-clean，扫描会
      // 每轮把这行捡起来重写一次，计划则一直启用着反复 422。
      flattenSingleRepo(body)
      await operations.persistence.updateHealedPayload({
        id: row.id,
        launchPayload: JSON.stringify(body),
        updatedAt: now,
      })
      converted += 1
      continue
    }
    const rootByPath = new Map<string, string>()
    let missing: string | undefined
    for (const { path } of pairs) {
      const root = await resolveGitRoot(path)
      if (root === null) {
        missing = path
        break
      }
      rootByPath.set(path, root)
    }
    if (missing !== undefined) {
      await disable(row, `rfc165-local-path-retired: ${missing}`)
      continue
    }
    let remoteRef: string | undefined
    for (const { path, ref } of pairs) {
      if (ref !== undefined && (await isRemoteTrackingRef(rootByPath.get(path)!, ref))) {
        remoteRef = ref
        break
      }
    }
    if (remoteRef !== undefined) {
      await disable(
        row,
        `rfc165-remote-tracking-ref: baseBranch '${remoteRef}' names a remote-tracking ref — pick a concrete branch/URL and re-save`,
      )
      continue
    }

    if (typeof body['repoPath'] === 'string') {
      body['repoUrl'] = toFileUrl(rootByPath.get(body['repoPath'] as string)!)
      if (typeof body['baseBranch'] === 'string') body['ref'] = body['baseBranch']
      delete body['repoPath']
      delete body['baseBranch']
    }
    for (const r of repos) {
      if (r === null || typeof r !== 'object') continue
      if (typeof r['repoPath'] === 'string') {
        r['repoUrl'] = toFileUrl(rootByPath.get(r['repoPath'] as string)!)
        if (typeof r['baseBranch'] === 'string') r['ref'] = r['baseBranch']
        delete r['repoPath']
        delete r['baseBranch']
      }
    }
    delete body['fetchBeforeLaunch']
    // 路径已在上面的循环里healed成 URL，这里把这唯一一条摊平进顶层并删除
    // `repos`，payload 才真正 v2-clean。
    flattenSingleRepo(body)

    await operations.persistence.updateHealedPayload({
      id: row.id,
      launchPayload: JSON.stringify(body),
      updatedAt: now,
    })
    converted += 1
  }
  return { scanned: rows.length, converted, disabled }
}

/**
 * RFC-248: 把**至多一条**的存量 `repos[]` 摊平成顶层单仓字段，并删掉 `repos` 键。
 *
 * 单条 `repos` 语义上就是单仓（RFC-066 时代 length-1 走的正是单仓码路径，
 * 字节级等价），所以摊平是无损的。两条及以上的调用方在上面已经停发。
 *
 * 顶层字段**已存在时不覆盖**——那种 payload 本来就自相矛盾（schema 的
 * 单仓 ⊕ 组互斥会拒），保留顶层、丢掉数组是更可预期的一侧。
 */
function flattenSingleRepo(body: Record<string, unknown>): void {
  const raw = body['repos']
  if (!Array.isArray(raw)) return
  const only = raw.length === 1 ? (raw[0] as Record<string, unknown> | null) : null
  if (only !== null && typeof only === 'object') {
    for (const k of ['repoUrl', 'cachedRepoId', 'ref'] as const) {
      if (body[k] === undefined && typeof only[k] === 'string') body[k] = only[k]
    }
  }
  delete body['repos']
}
