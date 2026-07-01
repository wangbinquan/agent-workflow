// Locks the false-root fix (2026-06) at the authoritative (save/import) gate.
//
// The clarify/cross-clarify answer-injection target ports
// (`__clarify_response__`, `__external_feedback__`) and the cross output source
// ports (`to_questioner`, `to_designer`) are wired EXCLUSIVELY by the drag
// helpers as fixed channel pairs. buildScopeUpstreams (scheduler.ts) strips
// every edge touching them — so a stray PLAIN data edge onto one of these ports
// is silently dropped from the dispatch graph, erasing the node's real upstream
// dependency and making it a FALSE dispatch root (premature execution).
//
// The canvas guard blocks this on drop, but YAML import / hand-edit bypass it.
// validateWorkflowDef is the authoritative gate: a non-canonical channel-port
// edge must surface `system-port-illegal-source` / `system-port-illegal-target`.
//
// Incident: an upstream output dropped onto an agent's `__clarify_response__`
// made the agent run before its real predecessor.

import type { Agent, WorkflowDefinition, WorkflowEdge } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'

import { validateWorkflowDef } from '../src/services/workflow.validator'

function agent(name: string, outputs: string[] = []): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function makeDef(parts: Partial<WorkflowDefinition>): WorkflowDefinition {
  return { $schema_version: 4, inputs: [], nodes: [], edges: [], ...parts }
}

const designer = agent('designer', ['design'])
const questioner = agent('questioner', ['main'])
const consumer = agent('consumer', ['out'])
// A non-cross node that (mis)declares the reserved cross output port names.
// buildScopeUpstreams strips `to_questioner` / `to_designer` by source-port
// name regardless of node kind, so these must be rejected too (Codex P2 #1).
const rogue = agent('rogue', ['to_questioner', 'to_designer', 'out'])

function codesOf(def: WorkflowDefinition): string[] {
  return validateWorkflowDef(def, {
    agents: [designer, questioner, consumer, rogue],
    skills: [],
  }).issues.map((i) => i.code)
}

const E = (id: string, s: [string, string], t: [string, string]): WorkflowEdge => ({
  id,
  source: { nodeId: s[0], portName: s[1] },
  target: { nodeId: t[0], portName: t[1] },
})

describe('clarify-channel system-port edge integrity', () => {
  test('canonical inline clarify → no system-port-illegal-* codes', () => {
    const def = makeDef({
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'topic' } as never,
        { id: 'a1', kind: 'agent-single', agentName: 'designer' } as never,
        { id: 'c1', kind: 'clarify' } as never,
      ],
      edges: [
        E('e_in', ['in', 'topic'], ['a1', 'topic']),
        E('e_ask', ['a1', '__clarify__'], ['c1', 'questions']),
        E('e_ans', ['c1', 'answers'], ['a1', '__clarify_response__']),
      ],
    })
    const codes = codesOf(def)
    expect(codes).not.toContain('system-port-illegal-source')
    expect(codes).not.toContain('system-port-illegal-target')
    expect(codes).not.toContain('system-port-mispaired-target')
  })

  test('canonical cross-clarify → no system-port-illegal-* codes', () => {
    const def = makeDef({
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'topic' } as never,
        { id: 'designer', kind: 'agent-single', agentName: 'designer' } as never,
        { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as never,
        { id: 'cross1', kind: 'clarify-cross-agent' } as never,
      ],
      edges: [
        E('e_in', ['in', 'topic'], ['designer', 'topic']),
        E('e_d_q', ['designer', 'design'], ['questioner', 'design']),
        E('e_ask', ['questioner', '__clarify__'], ['cross1', 'questions']),
        E('e_to_q', ['cross1', 'to_questioner'], ['questioner', '__clarify_response__']),
        E('e_to_d', ['cross1', 'to_designer'], ['designer', '__external_feedback__']),
      ],
    })
    const codes = codesOf(def)
    expect(codes).not.toContain('system-port-illegal-source')
    expect(codes).not.toContain('system-port-illegal-target')
    expect(codes).not.toContain('system-port-mispaired-target')
  })

  test('POISON: regular output → questioner.__clarify_response__ (the incident)', () => {
    const def = makeDef({
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'topic' } as never,
        { id: 'designer', kind: 'agent-single', agentName: 'designer' } as never,
        { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as never,
      ],
      edges: [
        E('e_in', ['in', 'topic'], ['designer', 'topic']),
        // upstream output dropped onto the answer-injection port → stripped → false root
        E('e_poison', ['designer', 'design'], ['questioner', '__clarify_response__']),
      ],
    })
    expect(codesOf(def)).toContain('system-port-illegal-source')
  })

  test('POISON: regular output → designer.__external_feedback__', () => {
    const def = makeDef({
      nodes: [
        { id: 'consumer', kind: 'agent-single', agentName: 'consumer' } as never,
        { id: 'designer', kind: 'agent-single', agentName: 'designer' } as never,
      ],
      edges: [E('e_poison', ['consumer', 'out'], ['designer', '__external_feedback__'])],
    })
    expect(codesOf(def)).toContain('system-port-illegal-source')
  })

  test('POISON: cross.to_questioner → a regular consumer input (forward fan-out)', () => {
    const def = makeDef({
      nodes: [
        { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as never,
        { id: 'cross1', kind: 'clarify-cross-agent' } as never,
        { id: 'consumer', kind: 'agent-single', agentName: 'consumer' } as never,
      ],
      edges: [
        E('e_ask', ['questioner', '__clarify__'], ['cross1', 'questions']),
        E('e_to_q', ['cross1', 'to_questioner'], ['questioner', '__clarify_response__']),
        // illegal forward fan-out onto a plain input → stripped → consumer false root
        E('e_poison', ['cross1', 'to_questioner'], ['consumer', 'answer']),
      ],
    })
    expect(codesOf(def)).toContain('system-port-illegal-target')
  })

  test('POISON: cross.to_designer → a regular consumer input', () => {
    const def = makeDef({
      nodes: [
        { id: 'cross1', kind: 'clarify-cross-agent' } as never,
        { id: 'consumer', kind: 'agent-single', agentName: 'consumer' } as never,
      ],
      edges: [E('e_poison', ['cross1', 'to_designer'], ['consumer', 'feedback'])],
    })
    expect(codesOf(def)).toContain('system-port-illegal-target')
  })

  test('POISON: clarify node feeds __clarify_response__ from a non-answers port', () => {
    const def = makeDef({
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'designer' } as never,
        { id: 'c1', kind: 'clarify' } as never,
      ],
      // 'questions' is the clarify INPUT port; using it as a source into the
      // answer-injection port is malformed — only 'answers' is legal.
      edges: [E('e_poison', ['c1', 'questions'], ['a1', '__clarify_response__'])],
    })
    expect(codesOf(def)).toContain('system-port-illegal-source')
  })

  // Codex P2 #1 — buildScopeUpstreams strips `to_questioner` / `to_designer` by
  // source-PORT name regardless of node kind, so a NON-cross node declaring one
  // of those reserved outputs is also dropped from dispatch. The rule must not
  // be gated on `src.kind === 'clarify-cross-agent'`.
  test('POISON: a NON-cross node uses the reserved to_questioner output port', () => {
    const def = makeDef({
      nodes: [
        { id: 'rogue', kind: 'agent-single', agentName: 'rogue' } as never,
        { id: 'consumer', kind: 'agent-single', agentName: 'consumer' } as never,
      ],
      edges: [E('e_poison', ['rogue', 'to_questioner'], ['consumer', 'x'])],
    })
    expect(codesOf(def)).toContain('system-port-illegal-target')
  })

  test('POISON: a NON-cross node uses the reserved to_designer output port (even at a canonical-looking target)', () => {
    const def = makeDef({
      nodes: [
        { id: 'rogue', kind: 'agent-single', agentName: 'rogue' } as never,
        { id: 'designer', kind: 'agent-single', agentName: 'designer' } as never,
      ],
      // Reserved source port on a non-cross node is illegal even when it points
      // at the canonical `__external_feedback__` injection target.
      edges: [E('e_poison', ['rogue', 'to_designer'], ['designer', '__external_feedback__'])],
    })
    expect(codesOf(def)).toContain('system-port-illegal-target')
  })

  // Codex P2 (confirmation pass) — a CANONICAL channel source pointing at the
  // WRONG agent's injection port still strips → false root. The answer must
  // return to the agent that owns the channel's `__clarify__ → questions` edge.
  test('POISON: clarify.answers injected into a non-asker agent', () => {
    const def = makeDef({
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'designer' } as never, // the asker
        { id: 'c1', kind: 'clarify' } as never,
        { id: 'other', kind: 'agent-single', agentName: 'consumer' } as never, // NOT the asker
      ],
      edges: [
        E('e_ask', ['a1', '__clarify__'], ['c1', 'questions']),
        // answer injected into 'other' instead of the asker 'a1'
        E('e_poison', ['c1', 'answers'], ['other', '__clarify_response__']),
      ],
    })
    const codes = codesOf(def)
    expect(codes).toContain('system-port-mispaired-target')
    // source side is valid → NOT an illegal-source
    expect(codes).not.toContain('system-port-illegal-source')
  })

  test('POISON: cross.to_questioner injected into a non-questioner agent', () => {
    const def = makeDef({
      nodes: [
        { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as never,
        { id: 'cross1', kind: 'clarify-cross-agent' } as never,
        { id: 'other', kind: 'agent-single', agentName: 'consumer' } as never,
      ],
      edges: [
        E('e_ask', ['questioner', '__clarify__'], ['cross1', 'questions']),
        E('e_poison', ['cross1', 'to_questioner'], ['other', '__clarify_response__']),
      ],
    })
    expect(codesOf(def)).toContain('system-port-mispaired-target')
  })

  // Codex P2 (pass 3) — answer-injection ports are AGENT system ports; the
  // generic port-missing check only validates output/wrapper targets, so a
  // non-agent target slips through and the runtime resolves the wrong node.
  test('POISON: cross.to_designer feeds a non-agent (review) __external_feedback__ target', () => {
    const def = makeDef({
      nodes: [
        { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as never,
        { id: 'cross1', kind: 'clarify-cross-agent' } as never,
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'questioner', portName: 'main' },
        } as never,
      ],
      edges: [
        E('e_ask', ['questioner', '__clarify__'], ['cross1', 'questions']),
        E('e_poison', ['cross1', 'to_designer'], ['rev', '__external_feedback__']),
      ],
    })
    expect(codesOf(def)).toContain('system-port-illegal-target')
  })

  // Codex P2 (pass 3) — the clarify `questions` input may only be fed by an
  // agent's `__clarify__` port; a normal output leaves the channel unrecognized
  // at runtime (discovery keys on `__clarify__`). Mirrors the canvas guard.
  test('POISON: a normal agent output wired into clarify.questions', () => {
    const def = makeDef({
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'designer' } as never,
        { id: 'c1', kind: 'clarify' } as never,
      ],
      // source port 'design' is a real agent output, but NOT '__clarify__'
      edges: [E('e_poison', ['a1', 'design'], ['c1', 'questions'])],
    })
    expect(codesOf(def)).toContain('system-port-illegal-source')
  })

  // Canvas/backend consistency — the `__clarify__` ask port and the clarify
  // `answers` port may only appear in their canonical channel shapes.
  test('POISON: agent.__clarify__ wired to a normal input (not a questions port)', () => {
    const def = makeDef({
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'designer' } as never,
        { id: 'b1', kind: 'agent-single', agentName: 'consumer' } as never,
      ],
      edges: [E('e_poison', ['a1', '__clarify__'], ['b1', 'ctx'])],
    })
    expect(codesOf(def)).toContain('system-port-illegal-target')
  })

  test('POISON: clarify.answers wired to a normal downstream consumer (settles-without-row early dispatch)', () => {
    const def = makeDef({
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'designer' } as never,
        { id: 'c1', kind: 'clarify' } as never,
        { id: 'b1', kind: 'agent-single', agentName: 'consumer' } as never,
      ],
      edges: [
        E('e_ask', ['a1', '__clarify__'], ['c1', 'questions']),
        E('e_ans', ['c1', 'answers'], ['a1', '__clarify_response__']), // canonical
        E('e_poison', ['c1', 'answers'], ['b1', 'ctx']), // leaks answers to a consumer
      ],
    })
    expect(codesOf(def)).toContain('system-port-illegal-target')
  })
})

// ---------------------------------------------------------------------------
// 2026-06-26 — false-root family, REVIEW-APPROVAL flavor.
//
// Bug report: "edge wrong port — use `accepted`, not clarify response." A review
// node's approval output (`accepted` for multi-document review, `approved_doc`
// for single-document) is a NORMAL downstream payload that must land on a
// consumer's real input. Dropping it onto an agent's `__clarify_response__`
// injection port — or feeding the consumer from a clarify channel where the
// review approval was the intended source — is the SAME stripped-edge →
// false-root incident the suite above locks. But every poison case above sources
// the stray edge from a plain AGENT output; the review-output variant the report
// describes was never exercised. RFC-079 already renamed this port once
// (approved_doc → accepted for multi-doc); these lock that a future rename can't
// silently slip a review approval past the system-port guard.
describe('system-port edge integrity — review approval output flavor', () => {
  // markdown upstreams so each review's own inputSource is valid and the only
  // surfaced system-port issue is the poison edge under test.
  const dSingle: Agent = { ...agent('d_single', ['design']), outputKinds: { design: 'markdown' } }
  const dMulti: Agent = {
    ...agent('d_multi', ['designs']),
    outputKinds: { designs: 'list<path<md>>' },
  }
  const sink = agent('sink', ['out'])
  const codesR = (def: WorkflowDefinition): string[] =>
    validateWorkflowDef(def, { agents: [dSingle, dMulti, sink], skills: [] }).issues.map(
      (i) => i.code,
    )

  test('CONTROL: review.approved_doc → a normal consumer input is clean', () => {
    const def = makeDef({
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'topic' } as never,
        { id: 'd', kind: 'agent-single', agentName: 'd_single' } as never,
        { id: 'rev', kind: 'review', inputSource: { nodeId: 'd', portName: 'design' } } as never,
        { id: 'sink', kind: 'agent-single', agentName: 'sink' } as never,
      ],
      edges: [
        E('e_in', ['in', 'topic'], ['d', 'topic']),
        E('e_rev', ['d', 'design'], ['rev', '__review_input__']),
        E('e_out', ['rev', 'approved_doc'], ['sink', 'doc']),
      ],
    })
    const codes = codesR(def)
    expect(codes).not.toContain('system-port-illegal-source')
    expect(codes).not.toContain('system-port-illegal-target')
  })

  test('POISON: review.approved_doc dropped onto an agent `__clarify_response__` port', () => {
    const def = makeDef({
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'topic' } as never,
        { id: 'd', kind: 'agent-single', agentName: 'd_single' } as never,
        { id: 'rev', kind: 'review', inputSource: { nodeId: 'd', portName: 'design' } } as never,
        { id: 'sink', kind: 'agent-single', agentName: 'sink' } as never,
      ],
      edges: [
        E('e_in', ['in', 'topic'], ['d', 'topic']),
        E('e_rev', ['d', 'design'], ['rev', '__review_input__']),
        // approval payload is NOT a clarify answer — stripped → sink false root
        E('e_poison', ['rev', 'approved_doc'], ['sink', '__clarify_response__']),
      ],
    })
    expect(codesR(def)).toContain('system-port-illegal-source')
  })

  test('POISON (multi-doc): review.accepted dropped onto an agent `__clarify_response__` port', () => {
    const def = makeDef({
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'topic' } as never,
        { id: 'd', kind: 'agent-single', agentName: 'd_multi' } as never,
        { id: 'rev', kind: 'review', inputSource: { nodeId: 'd', portName: 'designs' } } as never,
        { id: 'sink', kind: 'agent-single', agentName: 'sink' } as never,
      ],
      edges: [
        E('e_in', ['in', 'topic'], ['d', 'topic']),
        E('e_rev', ['d', 'designs'], ['rev', '__review_input__']),
        // the literal report: `accepted` is the multi-doc approval port; it belongs
        // on a normal consumer input, not the clarify-answer injection port.
        E('e_poison', ['rev', 'accepted'], ['sink', '__clarify_response__']),
      ],
    })
    expect(codesR(def)).toContain('system-port-illegal-source')
  })

  test('POISON: a consumer fed from clarify.answers where the review approval was intended', () => {
    const def = makeDef({
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'topic' } as never,
        { id: 'd', kind: 'agent-single', agentName: 'd_single' } as never,
        { id: 'clr', kind: 'clarify' } as never,
        { id: 'rev', kind: 'review', inputSource: { nodeId: 'd', portName: 'design' } } as never,
        { id: 'sink', kind: 'agent-single', agentName: 'sink' } as never,
      ],
      edges: [
        E('e_in', ['in', 'topic'], ['d', 'topic']),
        E('e_ask', ['d', '__clarify__'], ['clr', 'questions']),
        E('e_ans', ['clr', 'answers'], ['d', '__clarify_response__']), // canonical
        E('e_rev', ['d', 'design'], ['rev', '__review_input__']),
        // sink should consume rev.approved_doc; instead it reads the clarify
        // "response" — clarify.answers may only feed `__clarify_response__` (rule e).
        E('e_poison', ['clr', 'answers'], ['sink', 'doc']),
      ],
    })
    expect(codesR(def)).toContain('system-port-illegal-target')
  })
})
