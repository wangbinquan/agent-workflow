// RFC-269 — 「project 留空则取当前任务的仓库」（用户拍板 Q11）。
//
// 纯函数：输入是任务已有的仓库 URL 与所配 base URL，输出是可以直接嵌进 path 的
// 定位段。**不猜**是这里唯一的纪律 —— 推不出就给出一条能照着修的错误，而不是
// 拿一个半对的值去打别人的 API。

import { parseGitUrl } from '@agent-workflow/shared'
import type { CodeHostFailureCode, CodeHostProvider } from '@agent-workflow/shared'
import type { ProjectFallback } from '@/services/codeHost/call'

function hostOf(url: string): string | null {
  const parsed = parseGitUrl(url)
  if (parsed === null || parsed.kind === 'file') return null
  return parsed.host.toLowerCase()
}

function pathOf(url: string): string | null {
  const parsed = parseGitUrl(url)
  if (parsed === null || parsed.kind === 'file') return null
  // parseGitUrl 已剥前导斜杠；再剥 .git 后缀（clone URL 常带，API 路径不要）。
  const path = parsed.path.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  return path.length > 0 ? path : null
}

function baseHostOf(baseUrl: string): string | null {
  const m = /^https?:\/\/([^/:?#]+)/i.exec(baseUrl)
  return m === null ? null : m[1]!.toLowerCase()
}

function unresolved(code: CodeHostFailureCode, message: string): ProjectFallback {
  return { ok: false, code, message }
}

export interface ProjectFallbackInput {
  provider: CodeHostProvider
  /** 归一化后的 API 根。 */
  baseUrl: string
  /** GitLab-only repository URL prefixes that map to the configured API instance. */
  repositoryUrlPrefixes: readonly string[]
  /** 任务的仓库 URL（已 redact，凭据不在其中）。null = 任务不是从 URL 起的。 */
  repoUrl: string | null
  /** 任务的仓库数量。>1 时「当前任务的仓库」没有定义。 */
  repoCount: number
}

/**
 * 推导 project 定位段。
 *
 * GitLab 用 URL-encode 的 `namespace/path`（`/projects/:id` 接受它）；
 * GitHub 用 `owner/repo`（它在 path 里就是两段，不整体编码）。
 */
export function resolveProjectFallback(input: ProjectFallbackInput): ProjectFallback {
  if (input.repoCount > 1) {
    return unresolved(
      'code-host-project-unresolved',
      'this task spans multiple repositories, so "the task\'s repository" is undefined — fill in the project field explicitly',
    )
  }
  if (input.repoUrl === null || input.repoUrl.trim().length === 0) {
    return unresolved(
      'code-host-project-unresolved',
      'this task has no remote repository URL to derive the project from — fill in the project field explicitly',
    )
  }
  const repoHost = hostOf(input.repoUrl)
  const path = pathOf(input.repoUrl)
  if (repoHost === null || path === null) {
    return unresolved(
      'code-host-project-unresolved',
      `could not parse a project path out of the task repository URL — fill in the project field explicitly`,
    )
  }
  const baseHost = baseHostOf(input.baseUrl)
  if (baseHost === null) {
    return unresolved('code-host-project-unresolved', 'the configured base URL has no host')
  }
  // github.com 的 API 主机与仓库主机**本来就不同**（api.github.com vs
  // github.com），所以「repo host 必须等于 base host」这条判据在公有 GitHub 上
  // 恒假。GHES 没有这个分裂（同一主机下的 /api/v3），GitLab 也没有。
  const expectedRepoHost =
    input.provider === 'github' && baseHost === 'api.github.com' ? 'github.com' : baseHost
  const matchesPrimaryHost =
    repoHost === expectedRepoHost ||
    (input.provider === 'github' && repoHost === `www.${expectedRepoHost}`)
  const matchesGitLabPrefix =
    input.provider === 'gitlab' &&
    input.repositoryUrlPrefixes.some((prefix) => {
      let parsed: URL
      try {
        parsed = new URL(prefix)
      } catch {
        return false
      }
      if (parsed.hostname.toLowerCase() !== repoHost) return false
      const prefixPath = parsed.pathname.replace(/^\/+|\/+$/g, '')
      return prefixPath.length === 0 || path === prefixPath || path.startsWith(`${prefixPath}/`)
    })
  if (!matchesPrimaryHost && !matchesGitLabPrefix) {
    // 关键的一条：**不**因为「看起来像个 project path」就发出去。仓库属于另一台
    // 主机时，把它当成本实例的 project 会去改一个同名的、完全不相干的项目。
    return unresolved(
      'code-host-project-foreign',
      `the task repository is hosted on '${repoHost}', which is not the configured ${input.provider} instance '${expectedRepoHost}'` +
        (input.provider === 'gitlab' && input.repositoryUrlPrefixes.length > 0
          ? ' or any configured repository URL prefix'
          : ''),
    )
  }
  if (input.provider === 'gitlab') {
    return { ok: true, value: encodeURIComponent(path) }
  }
  const segments = path.split('/')
  if (segments.length < 2) {
    return unresolved(
      'code-host-project-unresolved',
      `GitHub needs owner/repo; the repository path '${path}' has no owner segment`,
    )
  }
  // GitHub 的 owner/repo 是**两个** path 段；逐段编码后再拼，既不破坏分段也
  // 不放过段内的特殊字符。
  const owner = segments[0]!
  const repo = segments.slice(1).join('/')
  return { ok: true, value: `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` }
}
