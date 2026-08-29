// P-5-05 single-binary embed table.
//
// In dev this file is a stub — the backend reads frontend dist and migrations
// from the filesystem (paths.migrationsDir + the vite dev server). The
// `scripts/build-binary.ts` script rewrites this file with `import … with
// { type: 'file' }` statements for every embedded asset before running
// `bun build --compile`, so the compiled binary ships all of them inside its
// executable. Keep the stub committed so dev/typecheck/lint never fail
// because the file is missing.

export const IS_EMBEDDED = false

/**
 * Bundled, self-contained launcher source used by the Windows standalone
 * executable. The binary build replaces this stub in memory; source execution
 * keeps using managedProcessLauncher.ts directly.
 */
export const MANAGED_PROCESS_LAUNCHER_SOURCE = ''

/** url-path -> embedded file path (resolves to a /$bunfs/... path at runtime). */
export const FRONTEND_FILES: Record<string, string> = {}

/** migrations-rel-path -> embedded file path. */
export const MIGRATION_FILES: Record<string, string> = {}

/**
 * RFC-029: opencode plugin asset table. Each entry maps a filename (no
 * path) to the embedded `/$bunfs/...` path at runtime. The runner copies
 * these into per-run dirs so opencode child processes can load them via
 * inline OPENCODE_CONFIG_CONTENT.plugin file:// URLs. In dev this stays
 * empty (the runner reads the source tree directly).
 */
export const PLUGIN_FILES: Record<string, string> = {}

/**
 * RFC-083: tree-sitter grammar + runtime wasm table for the structural-diff
 * engine. Keyed by basename (e.g. `tree-sitter-python.wasm`,
 * `tree-sitter.wasm`) → embedded `/$bunfs/...` path. In dev this stays empty
 * and `services/structuralDiff/lang/grammars.ts` resolves the wasms from
 * node_modules instead.
 */
export const GRAMMAR_FILES: Record<string, string> = {}
