// Native CLI fixture: each fresh process has its own session; resume echoes the
// requested session. The protocol fixtures otherwise retain their original behavior.
import { randomUUID } from 'node:crypto'
const protocol = process.argv[2]
process.argv.splice(2, 1)
const resumeFlag = protocol === 'claude-code' ? '--resume' : '--session'
const at = process.argv.indexOf(resumeFlag)
const sessionId = at >= 0 ? process.argv[at + 1]! : randomUUID()
if (protocol === 'claude-code') {
  process.env.MOCK_CLAUDE_SESSION_ID = sessionId
  await import('./mock-claude')
} else {
  process.env.MOCK_OPENCODE_EMIT_SESSION_ID = sessionId
  await import('./mock-opencode')
}
