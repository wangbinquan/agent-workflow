// RFC-304 §6.3 `run-target-gate` — finding the TARGET repository's own gate.
//
// After building something, the round has to check it. The wrong way to do that
// is to hardcode a command: `npm test` is wrong in most repositories and
// confidently so, and a platform that ran it would report a red gate on every
// Go, Rust, Python and Bun project it touched.
//
// The right source is the repository's own instructions to contributors, which
// is where a human looks for exactly this. `CLAUDE.md`, `CONTRIBUTING.md`,
// `AGENTS.md` — one of them usually says "run X before you push", and this
// module reads that sentence.
//
// ## What it does when it cannot find one
//
// It reports that it could not, and the round CONTINUES. That is a deliberate
// asymmetry with most of this RFC:
//
//   a gate that ran and failed  → the change is broken, stop.
//   no gate found               → the platform learned nothing. Stopping would
//                                 make the capability unusable in every
//                                 repository that documents its checks
//                                 somewhere this parser cannot read, which is
//                                 most of them.
//
// The distinction reaches the merge request description, so a reviewer knows
// whether "checks passed" means anything.

/** Files that conventionally tell a contributor how to check their work. */
export const GATE_DOC_CANDIDATES: readonly string[] = [
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
]

export type GateCommandSource = { file: string; line: number }

export interface FoundGateCommand {
  command: string
  source: GateCommandSource
}

/**
 * Phrases that introduce the command a contributor is told to run.
 *
 * Matched case-insensitively against the line BEFORE a fenced block or against
 * inline code on the same line. Deliberately a short list of imperative
 * phrasings rather than a general parser: a loose match ("run") would pick up
 * "run the dev server", and a round that gated on `bun run dev` would hang.
 */
const GATE_PHRASES: readonly RegExp[] = [
  /\bbefore (?:you )?(?:push|commit|opening a (?:pr|mr))\b/i,
  /\b(?:must|should) (?:be )?(?:all )?green\b/i,
  /\brun the (?:full )?(?:local )?(?:quality |test )?gate\b/i,
  /\bfull (?:local )?gate\b/i,
  /\brun (?:the )?tests? before\b/i,
]

/** A command token that is a development server rather than a check. */
const NOT_A_GATE = /\b(?:dev|serve|start|watch|storybook)\b/

/**
 * Read a gate command out of a contributor document.
 *
 * Returns the FIRST plausible command, not the best one. "Best" would need
 * judgement, and judging which of two commands is the real gate is exactly the
 * kind of thing the constitution keeps out of program stages — a wrong guess
 * here fails an honest change.
 */
export function findGateCommand(file: string, contents: string): FoundGateCommand | null {
  const lines = contents.split('\n')

  for (const [index, line] of lines.entries()) {
    if (!GATE_PHRASES.some((phrase) => phrase.test(line))) continue

    // Inline first: "run `bun run gate:local` before you push" is one line, and
    // it is the commonest phrasing.
    const inline = normalizeCommand(/`([^`\n]{2,200})`/.exec(line)?.[1])
    if (inline !== null) return { command: inline, source: { file, line: index + 1 } }

    // Otherwise the next fenced block, within a few lines: prose commonly reads
    // "before you push, run:" followed by a block.
    const fenced = fencedCommandAfter(lines, index)
    if (fenced !== null) {
      return { command: fenced.command, source: { file, line: fenced.line } }
    }
  }

  return null
}

function fencedCommandAfter(
  lines: readonly string[],
  from: number,
): { command: string; line: number } | null {
  // Four lines of slack: enough for a blank line and a sentence, short enough
  // that an unrelated block further down the document is not adopted.
  const limit = Math.min(lines.length, from + 5)
  for (let index = from + 1; index < limit; index += 1) {
    if (!(lines[index] ?? '').trimStart().startsWith('```')) continue
    const candidate = normalizeCommand(lines[index + 1])
    return candidate === null ? null : { command: candidate, line: index + 2 }
  }
  return null
}

/**
 * Commands a repository plausibly gates on.
 *
 * A closed list, and knowingly incomplete — adding to it is expected. The
 * alternative was a shape rule ("looks like an invocation"), which accepted
 * `everything is working fine` from the sentence "make sure `everything is
 * working fine`": four plain words separated by spaces are indistinguishable
 * from `bun run gate` by shape alone.
 *
 * Under-matching is the safe direction. Everything this list misses degrades to
 * "no gate found", which is a stated outcome that lets the round continue;
 * everything a looser rule wrongly accepts becomes a subprocess the platform
 * runs in somebody's repository.
 */
const KNOWN_RUNNERS: ReadonlySet<string> = new Set([
  'bun',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'make',
  'just',
  'task',
  'cargo',
  'go',
  'mvn',
  'gradle',
  './gradlew',
  'dotnet',
  'swift',
  'zig',
  'python',
  'python3',
  'poetry',
  'uv',
  'tox',
  'pytest',
  'ruff',
  'mix',
  'rake',
  'bundle',
  'composer',
  'ctest',
  'cmake',
  'bazel',
  'pnpx',
  'deno',
  'tsc',
  'vitest',
  'jest',
])

/**
 * The command a documented snippet actually names, or null.
 *
 * Normalising and validating in ONE function on purpose: they were two, and the
 * `$ ` prompt was stripped for the validity check and then returned WITH the
 * prompt still on it — the platform would have tried to execute `$`.
 */
function normalizeCommand(raw: string | undefined): string | null {
  if (raw === undefined) return null
  let text = raw.trim()
  // A shell prompt marker is part of the documentation, not the command.
  if (text.startsWith('$ ')) text = text.slice(2).trim()

  if (text === '' || text.length > 200) return null
  // Multiple statements: a documented sequence is a recipe for a human, and
  // running it unattended is a bigger promise than this stage makes.
  if (/[;&|]/.test(text)) return null
  if (NOT_A_GATE.test(text)) return null
  // Must look like an invocation rather than prose.
  if (!/^[\w./-]+(?:\s+[\w:@./=-]+)*$/.test(text)) return null

  const head = text.split(/\s+/)[0] ?? ''
  // A path is self-evidently an executable; a bare single token is a command
  // name (`pytest`, `make`); anything else has to be a runner we recognise, or
  // it is prose that happens to be made of word characters.
  const isPath = head.includes('/')
  const isBare = !text.includes(' ')
  if (!isPath && !isBare && !KNOWN_RUNNERS.has(head)) return null

  return text
}

export type GateOutcome =
  /** Ran, and the repository's own checks passed. */
  | { kind: 'passed'; command: string; source: GateCommandSource }
  /** Ran and failed. The change is broken; the round stops. */
  | { kind: 'failed'; command: string; source: GateCommandSource; output: string }
  /**
   * No gate found. The round CONTINUES — the platform learned nothing, which is
   * different from learning the change is bad.
   */
  | { kind: 'not-found'; searched: readonly string[] }
  /** Found one and could not run it (missing tool, timeout). Also continues. */
  | { kind: 'unrunnable'; command: string; reason: string }

/**
 * The line the merge request description carries about the gate.
 *
 * A reviewer's first question about an automated change is "was this checked?",
 * and the three answers are genuinely different. Saying "checks passed" when no
 * gate ran would be the most damaging thing this module could do.
 */
export function describeGateOutcome(outcome: GateOutcome): string {
  switch (outcome.kind) {
    case 'passed':
      return `\`${outcome.command}\` passed (from ${outcome.source.file}:${String(outcome.source.line)}).`
    case 'failed':
      return `\`${outcome.command}\` FAILED (from ${outcome.source.file}:${String(outcome.source.line)}).`
    case 'not-found':
      return `No gate command was found in ${outcome.searched.join(', ')}, so nothing was verified beyond the change itself.`
    case 'unrunnable':
      return `\`${outcome.command}\` could not be run (${outcome.reason}), so nothing was verified beyond the change itself.`
  }
}
