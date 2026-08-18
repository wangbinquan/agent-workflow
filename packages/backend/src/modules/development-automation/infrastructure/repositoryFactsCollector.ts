// RFC-310 PR-5 T53 —— RepositoryFactsCollectorPort 的生产实现。
//
// repositoryId → cached_repos.localPath（gitBaselineReader 同款定位）→ 真仓库
// 启发式探测：languages（扩展名）/ buildSystems（构建文件）/ moduleIds
// （maven <modules> 或含构建文件的顶层子目录，根含构建文件记 'root'）。
// cells 的 sourceRevision = exact HEAD sha：HEAD 前进后 re-collect 产生新
// sourceRevision ⇒ cells 内容变化 ⇒ decision dedup 键自然重开（refresh/失效
// 不需要专用逻辑，design §2.6）。
//
// context projection（T53 后半）：module catalog 之外把 contributor 指令文档
// （CONTRIBUTING/AGENTS/CLAUDE 类根文档）与 per-module 语言归属投影为 `__`
// 前缀内部 cells——它们是 prompt/上下文素材而非规则 facts（catalog 之外的键
// 一律走 `__` 内部投影约定；正文永不进 cells，只投影相对路径/归属对）。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { cachedRepos } from '@/db/schema'
import { runGit } from '@/util/git'
import type { FactCell } from '../domain/factCell'
import type { FactCellValue } from '../domain/facts'
import type { RepositoryFactsCollectorPort } from '../application/ports/reconcilerPorts'

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.h': 'cpp',
  '.c': 'c',
}

const BUILD_FILES: Readonly<Record<string, string>> = {
  'pom.xml': 'maven',
  'build.gradle': 'gradle',
  'build.gradle.kts': 'gradle',
  'settings.gradle': 'gradle',
  'settings.gradle.kts': 'gradle',
  'package.json': 'npm',
  'go.mod': 'go',
  'Cargo.toml': 'cargo',
  'CMakeLists.txt': 'cmake',
  Makefile: 'make',
  'pyproject.toml': 'pip',
  'requirements.txt': 'pip',
}

/** contributor 指令文档：存在性 + 相对路径投影（正文永不进 cells）。 */
const CONTRIBUTOR_DOCS = [
  'CONTRIBUTING.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.github/CONTRIBUTING.md',
  'docs/CONTRIBUTING.md',
] as const

const SKIP_DIRS = new Set(['.git', '.agent-workflow', 'node_modules', 'target', 'dist', 'build'])
const MAX_DEPTH = 4
const MAX_ENTRIES = 20_000

interface RepoScan {
  readonly languages: Set<string>
  readonly buildSystems: Set<string>
  readonly moduleBuildDirs: Set<string>
  readonly languagesByTopDir: Map<string, Set<string>>
}

function scanRepo(root: string): RepoScan {
  const scan: RepoScan = {
    languages: new Set(),
    buildSystems: new Set(),
    moduleBuildDirs: new Set(),
    languagesByTopDir: new Map(),
  }
  let visited = 0
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_DEPTH || visited > MAX_ENTRIES) return
    const abs = rel === '' ? root : join(root, rel)
    let names: string[]
    try {
      names = readdirSync(abs)
    } catch {
      return
    }
    for (const name of names.sort()) {
      if (visited > MAX_ENTRIES) return
      visited += 1
      const childRel = rel === '' ? name : `${rel}/${name}`
      let st
      try {
        st = statSync(join(root, childRel))
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        walk(childRel, depth + 1)
        continue
      }
      if (!st.isFile()) continue
      const buildSystem = BUILD_FILES[name]
      if (buildSystem !== undefined) {
        scan.buildSystems.add(buildSystem)
        const topDir = childRel.includes('/') ? childRel.split('/')[0]! : ''
        scan.moduleBuildDirs.add(topDir)
      }
      const dot = name.lastIndexOf('.')
      if (dot > 0) {
        const language = EXTENSION_LANGUAGES[name.slice(dot)]
        if (language !== undefined) {
          scan.languages.add(language)
          const topDir = childRel.includes('/') ? childRel.split('/')[0]! : 'root'
          const set = scan.languagesByTopDir.get(topDir) ?? new Set<string>()
          set.add(language)
          scan.languagesByTopDir.set(topDir, set)
        }
      }
    }
  }
  walk('', 0)
  return scan
}

/** maven 根 pom 的 <module> 列表（存在即优先作为 module catalog）。 */
function mavenModules(root: string): string[] {
  try {
    const pom = readFileSync(join(root, 'pom.xml'), 'utf8')
    const out: string[] = []
    for (const match of pom.matchAll(/<module>\s*([^<\s][^<]*?)\s*<\/module>/g)) {
      out.push(match[1]!)
    }
    return out
  } catch {
    return []
  }
}

export function createRepositoryFactsCollector(db: DbClient): RepositoryFactsCollectorPort {
  return {
    async collect(input) {
      const row = db
        .select({ localPath: cachedRepos.localPath })
        .from(cachedRepos)
        .where(eq(cachedRepos.id, input.repositoryId))
        .get()
      if (row === undefined) {
        throw new Error(`repository not cached: ${input.repositoryId}`)
      }
      const head = await runGit(row.localPath, ['rev-parse', 'HEAD'])
      if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) {
        throw new Error(`repository HEAD unresolvable: ${input.repositoryId}`)
      }
      const headSha = head.stdout.trim()

      const scan = scanRepo(row.localPath)
      const fromMaven = mavenModules(row.localPath)
      const moduleIds =
        fromMaven.length > 0
          ? fromMaven
          : [...scan.moduleBuildDirs].map((dir) => (dir === '' ? 'root' : dir))
      const contributorDocs = CONTRIBUTOR_DOCS.filter((rel) => {
        try {
          return statSync(join(row.localPath, rel)).isFile()
        } catch {
          return false
        }
      })

      const known = (value: FactCellValue): FactCell<FactCellValue> => ({
        state: 'known',
        value,
        sourceRevision: headSha,
      })
      const cells: Record<string, FactCell<FactCellValue>> = {
        'repository.languages': known([...scan.languages].sort()),
        'repository.buildSystems': known([...scan.buildSystems].sort()),
        'repository.moduleIds': known([...new Set(moduleIds)].sort()),
        'repository.defaultBranchKnown': known(true),
        // context projection（内部 `__` cells：素材，不是规则 facts）。
        '__repository.contributorDocs': known([...contributorDocs]),
        '__repository.languageByModule': known(
          [...scan.languagesByTopDir.entries()]
            .flatMap(([dir, langs]) => [...langs].sort().map((lang) => `${dir}=${lang}`))
            .sort(),
        ),
      }
      return { cells, factsRef: `repo:${headSha}` }
    },
  }
}
