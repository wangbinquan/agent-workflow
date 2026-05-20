// RFC-050 — locks the output-language directive plumbing in the distiller.
//
// Verifies:
//   D1: outputLang='en-US' (and undefined fallback) appends the English
//       directive at the END of the user prompt.
//   D2: outputLang='zh-CN' appends the Chinese directive at the END.
//   D3: runDistill reads outputLang FROM THE JOB ROW (not config) so
//       retries / merged-sibling reruns stay consistent even if the
//       admin flips config.memoryDistillLang mid-batch.
//   D4: DISTILLER_SYSTEM_PROMPT body is unchanged vs RFC-041 baseline:
//       no occurrences of either directive's distinguishing characters
//       have leaked into the system prompt. (The full SHA-256 hash lock
//       lives in memory-distiller-grep-output-lang-directive.test.ts so
//       that test file owns the dedicated source-layer guard surface.)

import { describe, expect, test } from 'bun:test'
import {
  buildDistillerUserPrompt,
  DISTILLER_OUTPUT_LANG_DIRECTIVE,
  DISTILLER_SYSTEM_PROMPT,
  runDistill,
  type DistillerSpawnFn,
  type DistillerSpawnInput,
} from '../src/services/memoryDistiller'
import { createInMemoryDb } from '../src/db/client'
import { resolve } from 'node:path'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const EMPTY_EVENTS = { clarify: [], review: [], feedback: [] }

describe('RFC-050 buildDistillerUserPrompt — output language directive', () => {
  test('D1: outputLang en-US (default) appends English directive at the end', () => {
    const promptDefault = buildDistillerUserPrompt({
      events: EMPTY_EVENTS,
      scopeContexts: [],
      taskId: null,
    })
    const promptExplicit = buildDistillerUserPrompt({
      events: EMPTY_EVENTS,
      scopeContexts: [],
      taskId: null,
      outputLang: 'en-US',
    })
    // Both must equal each other byte-for-byte: omitted outputLang === 'en-US'.
    expect(promptDefault).toBe(promptExplicit)
    expect(promptDefault.endsWith(DISTILLER_OUTPUT_LANG_DIRECTIVE['en-US'])).toBe(true)
    // The directive must come AFTER the existing "# Instructions" block.
    const instrIdx = promptDefault.indexOf('# Instructions')
    const dirIdx = promptDefault.lastIndexOf(DISTILLER_OUTPUT_LANG_DIRECTIVE['en-US'])
    expect(instrIdx).toBeGreaterThan(-1)
    expect(dirIdx).toBeGreaterThan(instrIdx)
    // English directive must NOT contain CJK characters.
    expect(/\p{Script=Han}/u.test(DISTILLER_OUTPUT_LANG_DIRECTIVE['en-US'])).toBe(false)
  })

  test('D2: outputLang zh-CN appends the Chinese directive at the end', () => {
    const prompt = buildDistillerUserPrompt({
      events: EMPTY_EVENTS,
      scopeContexts: [],
      taskId: null,
      outputLang: 'zh-CN',
    })
    expect(prompt.endsWith(DISTILLER_OUTPUT_LANG_DIRECTIVE['zh-CN'])).toBe(true)
    expect(prompt.endsWith(DISTILLER_OUTPUT_LANG_DIRECTIVE['en-US'])).toBe(false)
    // Chinese directive must contain CJK characters AND keep the literal
    // `[category:xxx]` lowercase-ASCII prefix marker so the category
    // protocol survives translation.
    expect(/\p{Script=Han}/u.test(DISTILLER_OUTPUT_LANG_DIRECTIVE['zh-CN'])).toBe(true)
    expect(DISTILLER_OUTPUT_LANG_DIRECTIVE['zh-CN']).toContain('[category:xxx]')
  })

  test('D3: runDistill reads outputLang from the job row (mid-batch config flip is ignored)', async () => {
    const captured: DistillerSpawnInput[] = []
    const spawnFn: DistillerSpawnFn = async (input) => {
      captured.push(input)
      return {
        exitCode: 0,
        stdout:
          '<workflow-output><port name="candidates">{"candidates":[]}</port></workflow-output>',
        stderr: '',
      }
    }
    const db = createInMemoryDb(MIGRATIONS)
    await runDistill({
      db,
      spawnFn,
      job: {
        id: 'job-zh',
        debounceKey: 'k',
        sourceKind: 'feedback',
        sourceEventId: 'evt',
        taskId: null,
        scopeResolved: {
          agentIds: [],
          workflowId: null,
          repoId: null,
          includeGlobal: true,
        },
        status: 'running',
        attempts: 0,
        nextRunAt: 0,
        lastError: null,
        createdAt: 0,
        startedAt: null,
        finishedAt: null,
        outputLang: 'zh-CN',
      },
      siblings: [],
    })
    await runDistill({
      db,
      spawnFn,
      job: {
        id: 'job-null',
        debounceKey: 'k2',
        sourceKind: 'feedback',
        sourceEventId: 'evt2',
        taskId: null,
        scopeResolved: {
          agentIds: [],
          workflowId: null,
          repoId: null,
          includeGlobal: true,
        },
        status: 'running',
        attempts: 0,
        nextRunAt: 0,
        lastError: null,
        createdAt: 0,
        startedAt: null,
        finishedAt: null,
        outputLang: null,
      },
      siblings: [],
    })
    expect(captured).toHaveLength(2)
    expect(captured[0]!.userPrompt.endsWith(DISTILLER_OUTPUT_LANG_DIRECTIVE['zh-CN'])).toBe(true)
    // null on the row → 'en-US' runtime fallback (RFC-041 baseline preserved).
    expect(captured[1]!.userPrompt.endsWith(DISTILLER_OUTPUT_LANG_DIRECTIVE['en-US'])).toBe(true)
  })

  test('D4: DISTILLER_SYSTEM_PROMPT body has no CJK characters (still English-only)', () => {
    // Spot-check the cheapest invariant; the SHA-256 hash baseline lives in
    // memory-distiller-grep-output-lang-directive.test.ts (T4 grep guard).
    expect(/\p{Script=Han}/u.test(DISTILLER_SYSTEM_PROMPT)).toBe(false)
    expect(DISTILLER_SYSTEM_PROMPT).toContain('written in plain English')
  })
})
