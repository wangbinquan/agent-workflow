// RFC-328 / RFC-400 — the managed-process launcher's script entry (source runs and the embedded
// Windows launcher source; compiled binaries use main.ts's hidden subcommand).
//
// The top-level await is load-bearing: it keeps the launcher process alive while it waits for the
// activation frame on stdin. An un-awaited promise chain let Windows exit with code 0 before the
// frame arrived. It lives here, in a file no module imports, because a top-level await in the
// imported launcher module would make every importer (task execution, collaboration) an async ES
// module, and Bun 1.4.3's bundler can then emit `await __promiseAll([...])` without defining the
// helper. Locked by tests/architecture/rfc400-top-level-await-guard.test.ts.
import { runManagedProcessLauncher } from './managedProcessLauncher'

if (import.meta.main) {
  process.exit(await runManagedProcessLauncher(Bun.argv))
}
