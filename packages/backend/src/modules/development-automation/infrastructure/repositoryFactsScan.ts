// RFC-370 §10 V18 (a) — the repository facts scan, read from the HEAD tree.
//
// A repository baseline's working tree is not kept current (fetching moves its
// refs; on a hosted volume preparation only moves refs), so the facts come
// from HEAD's committed tree. The scan returns a small summary: a standalone
// daemon runs it in-process, a hosted one inside the development volume
// (`repository-facts-scan`), and the cells are projected from the summary in
// both.
import { runGit } from '@/util/git'

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
/** Directory depth below the root a file may sit at (the former walk's bound). */
const MAX_DEPTH = 4
const MAX_ENTRIES = 20_000

export interface RepositoryFactsScan {
  readonly headSha: string
  readonly languages: readonly string[]
  readonly buildSystems: readonly string[]
  /** Top-level directories holding a build file; '' is the root. */
  readonly moduleBuildDirs: readonly string[]
  readonly mavenModules: readonly string[]
  readonly contributorDocs: readonly string[]
  /** `<top-level dir or root>=<language>` pairs, sorted. */
  readonly languageByModule: readonly string[]
}

export async function scanRepositoryFacts(root: string): Promise<RepositoryFactsScan> {
  const head = await runGit(root, ['rev-parse', 'HEAD'])
  const headSha = head.stdout.trim()
  if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(headSha))
    throw new Error('repository HEAD unresolvable')
  const tree = await runGit(root, ['ls-tree', '-r', '-z', '--full-tree', headSha])
  if (tree.exitCode !== 0) throw new Error('repository HEAD tree unreadable')
  const languages = new Set<string>()
  const buildSystems = new Set<string>()
  const moduleBuildDirs = new Set<string>()
  const languagesByTopDir = new Map<string, Set<string>>()
  const files = new Set<string>()
  let visited = 0
  for (const record of tree.stdout.split('\0')) {
    if (record === '' || visited >= MAX_ENTRIES) continue
    const tab = record.indexOf('\t')
    if (tab < 0 || record.slice(0, tab).split(' ')[1] !== 'blob') continue
    const path = record.slice(tab + 1)
    const segments = path.split('/')
    const directories = segments.slice(0, -1)
    if (directories.length > MAX_DEPTH || directories.some((name) => SKIP_DIRS.has(name))) continue
    visited += 1
    files.add(path)
    const name = segments.at(-1)!
    const buildSystem = BUILD_FILES[name]
    if (buildSystem !== undefined) {
      buildSystems.add(buildSystem)
      moduleBuildDirs.add(directories.length > 0 ? directories[0]! : '')
    }
    const dot = name.lastIndexOf('.')
    if (dot > 0) {
      const language = EXTENSION_LANGUAGES[name.slice(dot)]
      if (language !== undefined) {
        languages.add(language)
        const topDir = directories.length > 0 ? directories[0]! : 'root'
        const set = languagesByTopDir.get(topDir) ?? new Set<string>()
        set.add(language)
        languagesByTopDir.set(topDir, set)
      }
    }
  }
  let mavenModules: string[] = []
  if (files.has('pom.xml')) {
    const pom = await runGit(root, ['show', `${headSha}:pom.xml`])
    if (pom.exitCode === 0)
      mavenModules = [...pom.stdout.matchAll(/<module>\s*([^<\s][^<]*?)\s*<\/module>/g)].map(
        (match) => match[1]!,
      )
  }
  return {
    headSha,
    languages: [...languages].sort(),
    buildSystems: [...buildSystems].sort(),
    moduleBuildDirs: [...moduleBuildDirs].sort(),
    mavenModules,
    contributorDocs: CONTRIBUTOR_DOCS.filter((doc) => files.has(doc)),
    languageByModule: [...languagesByTopDir.entries()]
      .flatMap(([dir, langs]) => [...langs].sort().map((lang) => `${dir}=${lang}`))
      .sort(),
  }
}
