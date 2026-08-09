// RFC-154 — the ONE skill-staging loop, shared by both runtimes (was two
// near-identical copies: runner.ts prepareSkills for opencode + the loop inside
// claudeCode/config.ts prepareClaudeConfigDir). Stages framework skills into
// `<configDir>/skills/<name>`:
//   managed  → cpSync (whole dir copy)      (RFC-178: skills are managed-only)
//   project  → skipped (the CLI self-discovers repo-local skills from cwd)
//
// The skills dir is created even for an EMPTY list — creating the config dir
// before spawn is a load-bearing side effect (opencode 1.17+ writes a
// .gitignore into OPENCODE_CONFIG_DIR on startup and exits 1 when the dir is
// missing; see runtime-smoke.test.ts) — Codex design-gate P2.
//
// Failure semantics differ by caller and are preserved from the pre-RFC-154
// copies: opencode (runner-era) FAILS the spawn on a staging error (the run
// would otherwise silently miss a skill); claude stages best-effort (a broken
// skill logs + the run continues), matching prepareClaudeConfigDir's historical
// try/catch.
//
// Leaf module: imports nothing from runner.ts / drivers → no module-init cycle.

import { cpSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Logger } from '@/util/log'

/**
 * 2026-08-09 — the one directory name a staged skill tree may NOT carry.
 *
 * Claude Code loads a `<skills-dir>/<name>/` entry that contains `.claude-plugin`
 * as a PLUGIN (`<name>@skills-dir`), not merely as a skill — measured on 2.1.226:
 * staging a skill with `.claude-plugin/plugin.json` makes it show up in the
 * `system/init` event's `plugins[]`. A plugin may declare hooks, agents and MCP
 * servers, so that path turns "the node selected a skill" into arbitrary command
 * execution at hook points.
 *
 * Until 2026-08-09 the claude spawn happened to be immune because
 * `--setting-sources ""` disabled user-scope discovery wholesale — the same flag
 * that also made the node's skills not work at all. Restoring skills (`user`)
 * removes that accidental cover, so the exclusion has to be explicit and here,
 * at the ONE place a skill tree crosses into a runtime config dir.
 *
 * Exact basename match: `.claude-plugin.md` and friends are ordinary files and
 * are staged untouched.
 */
const EXCLUDED_SKILL_ENTRY = '.claude-plugin'

/** Minimal skill shape (structurally matches runner.ts ResolvedSkill). */
export interface StagedSkill {
  name: string
  sourceKind: 'managed' | 'project'
  sourcePath?: string
}

export function stageSkills(
  configDir: string,
  skills: readonly StagedSkill[],
  log: Logger,
  opts?: { bestEffort?: boolean },
): void {
  const skillsDir = join(configDir, 'skills')
  // Unconditional — even with zero skills the config dir must exist pre-spawn.
  mkdirSync(skillsDir, { recursive: true })
  for (const skill of skills) {
    if (skill.sourceKind === 'project') continue
    if (skill.sourcePath === undefined) {
      log.warn('skill missing sourcePath; skipping injection', { name: skill.name })
      continue
    }
    const dst = join(skillsDir, skill.name)
    // Ensure parent exists (skillsDir already does, but defensive).
    mkdirSync(dirname(dst), { recursive: true })
    try {
      // RFC-178: managed-only — copy the whole snapshot dir, minus the one
      // entry that would re-enter the runtime as a PLUGIN (see above). A
      // directory rejected here takes its whole subtree with it.
      let excluded = 0
      cpSync(skill.sourcePath, dst, {
        recursive: true,
        filter: (src) => {
          if (basename(src) !== EXCLUDED_SKILL_ENTRY) return true
          excluded += 1
          return false
        },
      })
      if (excluded > 0) {
        log.warn('skill tree carried .claude-plugin; excluded from the staged copy', {
          name: skill.name,
          entries: excluded,
        })
      }
    } catch (err) {
      if (opts?.bestEffort !== true) throw err
      log.warn('skill injection failed', {
        name: skill.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
