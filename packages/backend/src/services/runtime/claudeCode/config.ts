// RFC-111 PR-C — Claude Code per-attempt config dir prep: skills injection +
// subscription-credential bridge (D13/D16). Verified hands-on (design §6.1):
// relocating CLAUDE_CONFIG_DIR isolates the transcript + skills BUT breaks
// subscription auth; writing a single `<dir>/.credentials.json` restores it
// (macOS: extracted from the `Claude Code-credentials` keychain item; Linux:
// copied from the real ~/.claude/.credentials.json). API-key / token env auth
// is orthogonal to the relocated dir — no bridge needed there.
//
// Trust boundary (Codex P2-1): ONLY the credentials file is bridged — never the
// user's settings / agents / plugins / hooks / ~/.claude.json.

import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Logger } from '@/util/log'
import { linkSkillDir } from '@/util/platform'
import { secureFile } from '@/util/fs-perms'

/** Minimal skill shape (structurally matches runner.ts ResolvedSkill; no import → no cycle). */
export interface ClaudeSkillInjection {
  name: string
  sourceKind: 'managed' | 'external' | 'project'
  sourcePath?: string
}

/**
 * Prepare `<configDir>` (= CLAUDE_CONFIG_DIR) for one claude run: inject managed
 * (copied) / external (symlinked) skills under `skills/` (project skills are
 * left for claude to self-discover from the repo), then bridge the subscription
 * credential file when needed. Best-effort: a bridge failure is logged, not
 * fatal — claude surfaces a clear "Not logged in" if auth is truly missing.
 */
export function prepareClaudeConfigDir(
  configDir: string,
  skills: readonly ClaudeSkillInjection[],
  log: Logger,
  bridgeCredentials: boolean,
): void {
  mkdirSync(configDir, { recursive: true })
  const skillsDir = join(configDir, 'skills')
  mkdirSync(skillsDir, { recursive: true })
  for (const skill of skills) {
    if (skill.sourceKind === 'project') continue
    if (skill.sourcePath === undefined) {
      log.warn('claude skill missing sourcePath; skipping injection', { name: skill.name })
      continue
    }
    const dst = join(skillsDir, skill.name)
    mkdirSync(dirname(dst), { recursive: true })
    try {
      if (skill.sourceKind === 'managed') {
        cpSync(skill.sourcePath, dst, { recursive: true })
      } else {
        linkSkillDir(skill.sourcePath, dst)
      }
    } catch (err) {
      log.warn('claude skill injection failed', {
        name: skill.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (bridgeCredentials) bridgeClaudeCredentials(configDir, log)
}

/**
 * Bridge the subscription credential into the relocated config dir. No-op when
 * env-based auth is present (API key / OAuth token / Bedrock-Vertex are
 * orthogonal to CLAUDE_CONFIG_DIR). macOS reads the keychain; Linux copies the
 * real credentials file. Writes `0600`. Best-effort.
 */
function bridgeClaudeCredentials(configDir: string, log: Logger): void {
  // Env-based auth wins and is unaffected by the relocated dir — skip the bridge.
  if (
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN
  ) {
    return
  }
  const dest = join(configDir, '.credentials.json')
  try {
    if (process.platform === 'darwin') {
      const out = Bun.spawnSync([
        'security',
        'find-generic-password',
        '-s',
        'Claude Code-credentials',
        '-w',
      ])
      if (out.exitCode === 0) {
        const json = out.stdout.toString().trim()
        if (json.length > 0) {
          writeFileSync(dest, json + '\n', { mode: 0o600 })
          // RFC-windows PR-2 T9: the bridged credentials file is sensitive —
          // restrict to current user (POSIX chmod already done via mode flag;
          // Windows needs icacls since chmod is a no-op there).
          secureFile(dest)
        }
      }
    } else {
      const src = join(homedir(), '.claude', '.credentials.json')
      if (existsSync(src)) {
        copyFileSync(src, dest)
        secureFile(dest)
      }
    }
  } catch (err) {
    // Non-fatal: if auth is genuinely missing claude exits with a clear
    // "Not logged in" result (is_error) which the runner maps to failed.
    log.warn('claude credential bridge failed (continuing)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
