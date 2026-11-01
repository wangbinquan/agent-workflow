// RFC-414 — a standalone daemon checks its own filesystem for an entry below the action workspace (its `.git`, an input
// mount; RFC-370 §10 V18). Moved verbatim from composition/actionExecutionRunners.ts; a hosted deployment selects its
// workspace implementation's entries instead.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const localActionWorkspaceEntries = {
  exists: async (workspacePath: string, relativePath: string): Promise<boolean> =>
    existsSync(join(workspacePath, relativePath)),
}
