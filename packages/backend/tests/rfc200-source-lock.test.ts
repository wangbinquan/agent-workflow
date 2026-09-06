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
    const mintRecord = read(
      'packages/backend/src/modules/task-execution/application/buildNodeRunMintRecord.ts',
    )
    expect(mint).toContain('return generateNodeRunEnvelopeNonce()')
    expect(mintRecord).toContain("return randomBytes(8).toString('hex')")
    expect(mintRecord).toContain(
      'envelopeNonce: overrides.envelopeNonce ?? generateNodeRunEnvelopeNonce()',
    )

    const runner = read('packages/backend/src/services/runner.ts')
    expect(runner).toContain(
      'const envelopeNonce = await opts.persistence.nodeRuns.loadEnvelopeNonce(opts.nodeRunId)',
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
    expect(prompt).toContain("fence('review-comments', rc?.comments)")
    expect(prompt).toContain("fence('review-comments', reviewComments.value)")
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
    const wrapperMechanics = read(
      'packages/backend/src/modules/task-execution/composition/wrapperMechanics.ts',
    )
    const nodeMechanics = read(
      'packages/backend/src/modules/task-execution/composition/nodeMechanics.ts',
    )
    expect(wrapperMechanics).toContain('inputs: aggInputs')
    expect(nodeMechanics).toContain("values.join('\\n\\n---\\n\\n')")
    expect(wrapperMechanics).toContain('composePriorOutputBlock(')
    expect(nodeMechanics).toContain('state.opts.persistence.nodeRuns.loadEnvelopeNonce(nodeRunId)')
    expect(wrapperMechanics).toContain(
      "(await state.opts.persistence.nodeExecution.read(aggRunId))?.envelopeNonce ?? ''",
    )

    const memory = read('packages/backend/src/modules/memory/domain/injectionRendering.ts')
    // RFC-317 T39（CC-13）—— 围栏的 nonce 现在来自**必传的判别式**而不是默认参数：
    // 空 nonce 曾经默默走「不加围栏」的分支，安全路径是你得记得去要的那一条。
    expect(memory).toContain('fenceUntrusted(`memory:${m.id}`, m.bodyMd, fencing.nonce)')
    expect(memory).toContain("fencing.kind === 'legacy-unfenced'")

    // RFC-217 T3 — nonce 线程收编进回合骨架（唯一取用点），prompt 组装由各角色提供。
    // RFC-359 W4-D19c：骨架与三处角色组装合一进中立驱动，nonce 直接来自铸行回执
    //（不再单独查一次库）；本锁真正关心的「nonce 必须先取再渲染」不变。
    const driver = read(
      'packages/backend/src/modules/resource-catalog/application/workgroups/workgroupTurnsDriver.ts',
    )
    expect(driver.match(/spec\.prompt\(run\.envelopeNonce, errorNotice\)/g)?.length).toBe(1)
    expect(driver).toContain('renderWgProtocolBlock(')
    // 单卡派单 / 批量派单 / 消息回合三处组装都把 nonce 传进去。
    expect(driver).toContain(
      'composeMemberPrompt(input.snapshot, memberId, [input.assignment], nonce',
    )
    expect(driver).toContain('composeMemberPrompt(input.snapshot, input.memberId, cards, nonce)')
    expect(driver).toContain('composeMemberPrompt(input.snapshot, input.memberId, null, nonce)')

    const dynamic = read('packages/backend/src/services/dynamicWorkflowRunner.ts')
    expect(dynamic).toContain('const envelopeNonce = await nodeRuns.loadEnvelopeNonce(runId)')
    expect(dynamic).toContain('buildOrchestratorPrompt({')
    expect(dynamic).toContain('envelopeNonce,')
  })

  test('fusion and fan-in values remain data inputs, never direct protocol text', () => {
    const fusion = read(
      'packages/backend/src/modules/knowledge-evolution/application/fusionOrchestration.ts',
    )
    expect(fusion).toContain(
      'inputs: { intent: input.intent, memories: serializeMemoriesForPrompt(loaded) }',
    )

    const wrapperMechanics = read(
      'packages/backend/src/modules/task-execution/composition/wrapperMechanics.ts',
    )
    const nodeMechanics = read(
      'packages/backend/src/modules/task-execution/composition/nodeMechanics.ts',
    )
    expect(wrapperMechanics).toContain('aggInputs[edge.target.portName] = blocks.join')
    expect(nodeMechanics).toContain('inputs[name] = values.length === 1')
    // Both maps are ultimately passed as runNode.inputs and therefore fenced
    // by renderUserPrompt's generic input substitution/auto-append paths.
    expect(wrapperMechanics).toContain('inputs: aggInputs')
    expect(wrapperMechanics).toContain('inputs,')
  })

  test('internal commit and distiller agents have no bare-envelope bypass', () => {
    const commit = read('packages/backend/src/services/commitPush.ts')
    expect(commit).toContain('fenceUntrusted(name, value, envelopeNonce)')
    expect(commit).toContain("data('commit-diff', opts.diffTruncated)")
    expect(commit).toContain('extractLastEnvelope(stdout, envelopeNonce)')

    const scheduler = read('packages/backend/src/services/scheduler.ts')
    expect(scheduler).toContain('promptTemplate: buildPrompt(envelopeNonce)')

    const distiller = read(
      'packages/backend/src/modules/memory/application/distill/memoryDistiller.ts',
    )
    expect(distiller).toContain("fenceUntrusted('memory-distill-source-context'")
    expect(distiller).toContain('extractLastEnvelope(text, envelopeNonce)')
    expect(distiller).toContain('options.envelopeNonce ?? generateEnvelopeNonce()')
  })

  test('frontend preview uses a deterministic non-empty nonce', () => {
    const preview = read('packages/frontend/src/components/canvas/PromptPreview.tsx')
    expect(preview).toContain("envelopeNonce: 'PREVIEW'")
  })
})
