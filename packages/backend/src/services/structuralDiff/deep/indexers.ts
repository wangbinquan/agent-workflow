import { platformSpawnOptionsForHost } from '@/util/platformExec'
// RFC-083 PR-E — SCIP indexer registry + discovery. The deep engine shells out
// to an external per-language indexer (scip-typescript / scip-python / …),
// discovered on PATH (or a settings override), exactly like the daemon already
// finds `opencode` / `git`. The table is the single source of truth for which
// languages deep mode can attempt + how each indexer is invoked.

export type IndexerId =
  | 'scip-typescript'
  | 'scip-python'
  | 'scip-go'
  | 'rust-analyzer'
  | 'scip-clang'
  | 'scip-java'

/** Optional absolute-path overrides for each indexer binary (settings). */
export interface DeepIndexerOverrides {
  scipTypescript?: string
  scipPython?: string
  scipGo?: string
  scipClang?: string
  scipJava?: string
  rustAnalyzer?: string
}

export interface IndexerSpec {
  id: IndexerId
  defaultBin: string
  overrideKey: keyof DeepIndexerOverrides
  /** argv (after the binary) to index the cwd, writing SCIP to `outPath`. */
  buildArgs(outPath: string): string[]
  /** file extensions this indexer covers. */
  exts: string[]
  /** per-indexer default timeout (ms); heavy toolchains get more headroom. */
  timeoutMs: number
}

export const INDEXER_SPECS: Record<IndexerId, IndexerSpec> = {
  'scip-typescript': {
    id: 'scip-typescript',
    defaultBin: 'scip-typescript',
    overrideKey: 'scipTypescript',
    buildArgs: (o) => ['index', '--output', o],
    exts: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    timeoutMs: 120_000,
  },
  'scip-python': {
    id: 'scip-python',
    defaultBin: 'scip-python',
    overrideKey: 'scipPython',
    buildArgs: (o) => ['index', '--output', o, '.'],
    exts: ['.py', '.pyi'],
    timeoutMs: 120_000,
  },
  'scip-go': {
    id: 'scip-go',
    defaultBin: 'scip-go',
    overrideKey: 'scipGo',
    buildArgs: (o) => ['--output', o],
    exts: ['.go'],
    timeoutMs: 180_000,
  },
  'rust-analyzer': {
    id: 'rust-analyzer',
    defaultBin: 'rust-analyzer',
    overrideKey: 'rustAnalyzer',
    buildArgs: (o) => ['scip', '.', '--output', o],
    exts: ['.rs'],
    timeoutMs: 300_000,
  },
  'scip-clang': {
    id: 'scip-clang',
    defaultBin: 'scip-clang',
    overrideKey: 'scipClang',
    buildArgs: (o) => ['--index-output', o],
    exts: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h'],
    timeoutMs: 300_000,
  },
  'scip-java': {
    id: 'scip-java',
    defaultBin: 'scip-java',
    overrideKey: 'scipJava',
    buildArgs: (o) => ['index', '--output', o],
    exts: ['.java', '.scala', '.sc'],
    timeoutMs: 300_000,
  },
}

/** Which indexers the given changed-file paths require (by extension). */
export function indexersForFiles(paths: readonly string[]): IndexerId[] {
  const out = new Set<IndexerId>()
  for (const p of paths) {
    const dot = p.lastIndexOf('.')
    if (dot < 0) continue
    const ext = p.slice(dot).toLowerCase()
    for (const spec of Object.values(INDEXER_SPECS)) {
      if (spec.exts.includes(ext)) out.add(spec.id)
    }
  }
  return [...out]
}

/** Settings override wins over the PATH default binary name. */
export function resolveIndexerBin(spec: IndexerSpec, overrides?: DeepIndexerOverrides): string {
  const override = overrides?.[spec.overrideKey]
  return override !== undefined && override.length > 0 ? override : spec.defaultBin
}

export interface IndexerProbe {
  available: boolean
  bin: string
  version: string | null
}

/** Probe `<bin> --version` (mirrors probeOpencode). Absent binary → available
 *  false, never throws. */
export async function probeIndexer(
  spec: IndexerSpec,
  overrides?: DeepIndexerOverrides,
): Promise<IndexerProbe> {
  const bin = resolveIndexerBin(spec, overrides)
  try {
    const proc = Bun.spawn({
      ...platformSpawnOptionsForHost(),
      cmd: [bin, '--version'],
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) return { available: false, bin, version: null }
    return { available: true, bin, version: out.trim().split('\n')[0] ?? null }
  } catch {
    return { available: false, bin, version: null }
  }
}
