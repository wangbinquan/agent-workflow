// RFC-253 T43 (AC-39) — the snippets the Inspector hands an author must RUN.
//
// Why this file exists: before T43 the only output guidance in the UI was the
// literal string `<workflow-output nonce="$AW_ENVELOPE_NONCE">`. That is right
// for bash — the shell expands it inside an unquoted heredoc — and wrong for
// python / node, because D5 guarantees the platform substitutes nothing into a
// script body: the process printed a literal `$AW_ENVELOPE_NONCE`, the parser
// (scoped to the run's real nonce since RFC-200) matched nothing, and the node
// failed `script-envelope-missing` and burned its retries. A user reported
// exactly that confusion.
//
// A generated snippet is documentation the platform is responsible for, so the
// oracle here is end-to-end rather than textual: write the snippet to disk with
// the SAME extension and argv production uses (`INTERPRETER_SPEC`, imported —
// never hand-copied), run it under the real interpreter, then feed its stdout
// to the SAME `extractLastEnvelope` + `parseEnvelope` the runner uses. If a
// snippet ever stops being valid python / bash / node, or stops producing a
// parseable envelope, this goes red with the exact port that broke.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildScriptEnvelopeSnippet,
  buildScriptInputSnippet,
  scriptEnvSuffix,
  type ScriptLanguage,
} from '@agent-workflow/shared'
import { extractLastEnvelope, parseEnvelope } from '@/services/envelope'
import { runContainedProcess } from '@/services/execution/containedSpawn'
import { INTERPRETER_SPEC } from '@/services/scriptRun'

const LANGUAGES: ScriptLanguage[] = ['python', 'bash', 'node']

/** Absolute interpreter path, or null when this machine lacks it. */
function interpreterFor(language: ScriptLanguage): string | null {
  return Bun.which(INTERPRETER_SPEC[language].binary)
}

async function runSnippet(
  language: ScriptLanguage,
  body: string,
  env: Record<string, string>,
): Promise<{ stdout: string; exitCode: number | null; stderr: string }> {
  const bin = interpreterFor(language)
  if (bin === null) throw new Error(`no ${language} interpreter`)
  const dir = mkdtempSync(join(tmpdir(), 'rfc253-snippet-'))
  const scriptPath = join(dir, `script.${INTERPRETER_SPEC[language].ext}`)
  writeFileSync(scriptPath, body, 'utf8')
  const result = await runContainedProcess({
    argv: INTERPRETER_SPEC[language].argv(bin, scriptPath),
    cwd: dir,
    // The interpreter path is absolute, so a minimal PATH is enough; the point
    // is that the daemon's environment is never inherited.
    env: { PATH: '/usr/bin:/bin', ...env },
    captureRawStdout: true,
    timeoutMs: 30_000,
  })
  return { stdout: result.rawStdout, exitCode: result.exitCode, stderr: result.stderrTail }
}

// win32 has no `python3` and resolves `bash` through Git for Windows (see
// WINDOWS_INTERPRETER_CANDIDATES); the snippets themselves are OS-independent,
// so the POSIX runners carry this proof.
describe.skipIf(process.platform === 'win32')('T43 — generated snippets actually run', () => {
  // The per-language cases below skip when a machine lacks an interpreter, which
  // would make "no coverage" indistinguishable from "all green". This case never
  // skips: on CI every interpreter must be present, so a runner that loses one
  // goes red instead of quietly proving nothing.
  test('the interpreters this proof needs are present', () => {
    if (process.env.CI === undefined || process.env.CI === '') {
      // A contributor machine may legitimately lack node or python3; bash is
      // guaranteed on POSIX, so at least one language stays proven locally.
      expect(interpreterFor('bash')).not.toBeNull()
      return
    }
    expect(LANGUAGES.filter((language) => interpreterFor(language) === null)).toEqual([])
  })

  for (const language of LANGUAGES) {
    const available = interpreterFor(language) !== null

    test.skipIf(!available)(
      `${language}: the envelope snippet parses back into its ports`,
      async () => {
        const ports = ['summary', 'findings']
        const nonce = 'nonce-abc123'
        const { stdout, exitCode, stderr } = await runSnippet(
          language,
          buildScriptEnvelopeSnippet(language, ports),
          { AW_ENVELOPE_NONCE: nonce },
        )
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })

        // The nonce came from the environment, so the RUN's parser matches it.
        const envelope = extractLastEnvelope(stdout, nonce)
        expect(envelope).not.toBeNull()
        const parsed = parseEnvelope(envelope ?? '', ports, nonce)
        expect(parsed.missingDeclared).toEqual([])
        expect(parsed.malformedPorts).toEqual([])
        expect([...parsed.ports]).toEqual([
          ['summary', 'TODO'],
          ['findings', 'TODO'],
        ])

        // A DIFFERENT nonce must find nothing — proof the snippet emitted the
        // real value rather than the literal text `$AW_ENVELOPE_NONCE`, which
        // would have matched no run at all.
        expect(extractLastEnvelope(stdout, 'some-other-nonce')).toBeNull()
      },
    )

    test.skipIf(!available)(
      `${language}: hostile port names stay runnable and parseable`,
      async () => {
        // Every character that terminates a literal in one of the three target
        // languages, plus both XML attribute quotes (one at a time — a name
        // holding BOTH is unrepresentable and the validator rejects it).
        const ports = ["it's", 'say"hi', 'cost$here', 'tick`mark', 'back\\slash']
        const nonce = 'nonce-hostile'
        const { stdout, exitCode, stderr } = await runSnippet(
          language,
          buildScriptEnvelopeSnippet(language, ports),
          { AW_ENVELOPE_NONCE: nonce },
        )
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
        const parsed = parseEnvelope(extractLastEnvelope(stdout, nonce) ?? '', ports, nonce)
        expect(parsed.missingDeclared).toEqual([])
        expect(parsed.malformedPorts).toEqual([])
        for (const port of ports) expect(parsed.ports.get(port)).toBe('TODO')
      },
    )

    test.skipIf(!available)(
      `${language}: the input snippet reads the inline variable`,
      async () => {
        const suffix = scriptEnvSuffix('git-diff')
        const { stdout, exitCode, stderr } = await runSnippet(
          language,
          buildScriptInputSnippet(language, ['git-diff']) + echoVar(language, suffix),
          { [`AW_PORT_${suffix}`]: 'inline-value' },
        )
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
        expect(stdout).toBe('inline-value')
      },
    )

    test.skipIf(!available)(
      `${language}: the input snippet falls back to the spill file`,
      async () => {
        // Production shape for an oversized value: ONLY the file variable is set
        // (planScriptPortEnv never writes both), so a snippet that reads the
        // environment alone would hand the author an empty string here.
        const suffix = scriptEnvSuffix('git-diff')
        const dir = mkdtempSync(join(tmpdir(), 'rfc253-spill-'))
        const spillPath = join(dir, suffix)
        writeFileSync(spillPath, 'spilled-value', 'utf8')
        const { stdout, exitCode, stderr } = await runSnippet(
          language,
          buildScriptInputSnippet(language, ['git-diff']) + echoVar(language, suffix),
          { [`AW_PORT_FILE_${suffix}`]: spillPath },
        )
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
        expect(stdout).toBe('spilled-value')
      },
    )
  }
})

/** Print the variable the input snippet assigned, with no trailing newline. */
function echoVar(language: ScriptLanguage, name: string): string {
  if (language === 'bash') return `printf '%s' "$${name}"\n`
  if (language === 'node') return `process.stdout.write(${name})\n`
  return `print(${name}, end='')\n`
}
