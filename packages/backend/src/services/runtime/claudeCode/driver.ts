// RFC-111 PR-B — the Claude Code RuntimeDriver.
//
// The shared seam exposes `parseEvent` (the generic stdout pump consumes it for
// any runtime). Spawn assembly is runtime-branched in runNode (opencode inline
// config vs claude system-prompt-file differ too much for one ctx), so it lives
// in ./spawn.ts (buildClaudeSpawn) rather than on this object.

import type { NormalizedEvent, RuntimeDriver } from '../types'
import { parseEvent } from './events'

export const claudeCodeDriver: RuntimeDriver = {
  kind: 'claude-code',
  parseEvent(line: string): NormalizedEvent | null {
    return parseEvent(line)
  },
}
