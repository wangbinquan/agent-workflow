// RFC-391 — source locks follow the real command, session, application and adapter files.
// Each file occurs once; this corpus preserves cross-layer forwarding checks without
// reconstructing either retired provider graph or fabricating implementation text.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function readDaemonGraphSource(): string {
  return [
    'bootstrap/daemonStart.ts',
    'bootstrap/deploymentProfile.ts',
    'bootstrap/daemonSession.ts',
    'bootstrap/daemonApplication.ts',
    'bootstrap/daemonSessionAdapters.ts',
  ]
    .map(
      (path) =>
        `// Source: ${path}\n${readFileSync(resolve(import.meta.dir, '../../src', path), 'utf8')}`,
    )
    .join('\n')
}
