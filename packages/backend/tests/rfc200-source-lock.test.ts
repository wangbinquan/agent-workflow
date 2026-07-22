// RFC-200 §8.4 — source-level wiring locks for the nonce/fence chain. The
// behavioral tests exercise the real runner; these assertions keep future
// refactors from bypassing the shared prompt choke point on less common paths
// (fan-in, fan-out aggregation, fusion, workgroups and dynamic workflows).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

describe('RFC-200 source wiring locks', () => {
  test('one persisted run nonce drives prompt emit and every runner parse API', () => {
    const mint = read('packages/backend/src/services/nodeRunMint.ts')
    expect(mint).toContain("return randomBytes(8).toString('hex')")
    expect(mint).toContain('envelopeNonce: o.envelopeNonce ?? generateEnvelopeNonce()')

    const runner = read('packages/backend/src/services/runner.ts')
    expect(runner).toContain(
      'const envelopeNonce = await loadRunEnvelopeNonce(opts.db, opts.nodeRunId)',
    )
    for (const marker of [
      'renderEnvelopeFollowupPrompt({\n          envelopeNonce,',
      'renderUserPrompt({',
      'detectEnvelopeKind(accumulatedText, envelopeNonce)',
      'extractClarifyEnvelopeBody(accumulatedText, envelopeNonce)',
      'extractLastEnvelope(accumulatedText, envelopeNonce)',
      'parseEnvelope(envelope, opts.agent.outputs, envelopeNonce)',
    ]) {
      expect(runner).toContain(marker)
    }
    expect(runner).toMatch(/renderUserPrompt\(\{[\s\S]*?envelopeNonce,/)
  })

  test('all generic inputs, review values and prior output cross the shared fence choke point', () => {
    const prompt = read('packages/shared/src/prompt.ts')
    expect(prompt).toContain('const fence = (name: string, value: string | undefined): string =>')
    expect(prompt).toContain('return fence(name, v)')
    expect(prompt).toContain('${fence(name, content)}')
    expect(prompt).toContain("fence('review-rejection', rc.rejection)")
    expect(prompt).toContain("fence('review-comments', rc.comments)")
    expect(prompt).toContain("fence('review-sibling-outputs', rc.siblingOutputs)")
    expect(prompt).toContain("fence('prior-output', pou.block)")
    expect(prompt).toContain('awInputProtocolNote(nonce)')

    const clarify = read('packages/shared/src/clarify.ts')
    expect(clarify).toContain("fenceUntrusted('manual-instruction', b, nonce)")
    expect(clarify).toContain('nonce.length > 0 ? sanitizeInlineField(value) : value')
    expect(clarify).toContain('`- Q: ${safe(question.title)}`')
    expect(clarify).toContain('fenceUntrusted(`prior-output:${portName}`, o.content, nonce)')
  })

  test('specialized prompt producers thread the current run nonce before rendering', () => {
    const scheduler = read('packages/backend/src/services/scheduler.ts')
    expect(scheduler).toContain('inputs: aggInputs')
    expect(scheduler).toContain("values.join('\\n\\n---\\n\\n')")
    expect(scheduler).toContain('composePriorOutputBlock(')
    expect(scheduler).toContain('loadRunEnvelopeNonce(db, nodeRunId)')

    const memory = read('packages/backend/src/services/memoryInject.ts')
    expect(memory).toContain('fenceUntrusted(`memory:${m.id}`, m.bodyMd, envelopeNonce)')

    const workgroup = read('packages/backend/src/services/workgroup/runner.ts')
    expect(workgroup.match(/loadRunEnvelopeNonce\(db, runId\)/g)?.length).toBeGreaterThanOrEqual(3)
    // RFC-215 — composeMemberPrompt 收数组（lw 单卡包一层；fc 批直传），nonce
    // 线程不变（本锁真正关心的事）。RFC-215 实现门 C-2（2026-07-21）：领养单卡
    // 调用追加 { singleCard: true }（协议块/解析是 wg_result 单卡形态，prompt 同形）。
    expect(workgroup).toContain(
      'composeMemberPrompt(state, memberId, [assignment], envelopeNonce, { singleCard: true })',
    )
    expect(workgroup).toContain('composeMemberPrompt(state, memberId, batch, envelopeNonce)')
    // RFC-207 — the renderer gained a 4th arg (resolved ask-back permission); the
    // nonce must still be threaded, which is what this lock is actually about.
    expect(workgroup).toContain(
      "renderWgProtocolBlock(\n        'leader',\n        config,\n        envelopeNonce,",
    )

    const dynamic = read('packages/backend/src/services/dynamicWorkflowRunner.ts')
    expect(dynamic).toContain('const envelopeNonce = await loadRunEnvelopeNonce(db, runId)')
    expect(dynamic).toContain('buildOrchestratorPrompt({')
    expect(dynamic).toContain('envelopeNonce,')
  })

  test('fusion and fan-in values remain data inputs, never direct protocol text', () => {
    const fusion = read('packages/backend/src/services/fusion.ts')
    expect(fusion).toContain(
      'inputs: { intent: input.intent, memories: serializeMemoriesForPrompt(loaded) }',
    )

    const scheduler = read('packages/backend/src/services/scheduler.ts')
    expect(scheduler).toContain('aggInputs[edge.target.portName] = blocks.join')
    expect(scheduler).toContain('inputs[name] = values.length === 1')
    // Both maps are ultimately passed as runNode.inputs and therefore fenced
    // by renderUserPrompt's generic input substitution/auto-append paths.
    expect(scheduler).toContain('inputs: aggInputs')
    expect(scheduler).toContain('inputs,')
  })

  test('internal commit and distiller agents have no bare-envelope bypass', () => {
    const commit = read('packages/backend/src/services/commitPush.ts')
    expect(commit).toContain('fenceUntrusted(name, value, envelopeNonce)')
    expect(commit).toContain("data('commit-diff', opts.diffTruncated)")
    expect(commit).toContain('extractLastEnvelope(stdout, envelopeNonce)')

    const scheduler = read('packages/backend/src/services/scheduler.ts')
    expect(scheduler).toContain('promptTemplate: buildPrompt(envelopeNonce)')

    const distiller = read('packages/backend/src/services/memoryDistiller.ts')
    expect(distiller).toContain("fenceUntrusted('memory-distill-source-context'")
    expect(distiller).toContain('extractLastEnvelope(text, envelopeNonce)')
    expect(distiller).toContain('options.envelopeNonce ?? generateEnvelopeNonce()')
  })

  test('frontend preview uses a deterministic non-empty nonce', () => {
    const preview = read('packages/frontend/src/components/canvas/PromptPreview.tsx')
    expect(preview).toContain("envelopeNonce: 'PREVIEW'")
  })
})
