#!/usr/bin/env bun
// Deterministic OpenCode replacement for e2e/workgroup-matrix.spec.ts.
//
// The real binary, HTTP routes, SQLite state machines, scheduler, isolated
// worktrees, merge-back, prompt composer, envelope parser and human gates stay
// in the path. Only the external model process is replaced. Behaviour is
// selected from the real --agent name plus prompt content, so retries and
// resumptions must carry the right durable context to make progress.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

function fail(message: string, code = 2): never {
  process.stderr.write(`stub-opencode-workgroup-matrix: ${message}\n`)
  process.exit(code)
}

const argv = process.argv.slice(2)
if (argv.includes('--version') || argv[0] === 'version' || argv[0] === '-v') {
  process.stdout.write('stub-opencode workgroup-matrix\n')
  process.exit(0)
}
if (argv[0] !== 'run') fail(`unsupported mode: ${argv.join(' ') || '<none>'}`)

const agentFlag = argv.indexOf('--agent')
const agent = agentFlag >= 0 ? (argv[agentFlag + 1] ?? '') : ''
if (agent.length === 0) fail('missing --agent')

const separator = argv.indexOf('--')
const prompt = separator >= 0 ? argv.slice(separator + 1).join(' ') : (argv[1] ?? '')
const nonce = [...prompt.matchAll(/\bnonce="([^"]+)"/g)].at(-1)?.[1]
if (nonce === undefined || nonce.length === 0) fail('prompt is missing the RFC-200 nonce', 3)

const stateDir = process.env.WORKGROUP_MATRIX_STATE_DIR
if (stateDir === undefined || stateDir.length === 0) {
  fail('WORKGROUP_MATRIX_STATE_DIR is required')
}
mkdirSync(stateDir, { recursive: true })
appendFileSync(
  join(stateDir, 'prompts.jsonl'),
  `${JSON.stringify({ agent, cwd: process.cwd(), prompt })}\n`,
)

if (process.env.OPENCODE_AW_INVENTORY_OUT) {
  writeFileSync(
    process.env.OPENCODE_AW_INVENTORY_OUT,
    '{"schemaVersion":1,"capturedAt":1700000000000,"agents":[],"skills":[],"mcps":[],"plugins":[]}\n',
  )
}

function emitText(text: string): never {
  process.stdout.write(
    `${JSON.stringify({
      type: 'text',
      timestamp: Date.now(),
      part: { type: 'text', text },
    })}\n`,
  )
  process.exit(0)
}

function emitPorts(ports: Record<string, string>): never {
  const body = Object.entries(ports)
    .map(([name, value]) => `<port name="${name}">${value}</port>`)
    .join('\n')
  emitText(`<workflow-output nonce="${nonce}">\n${body}\n</workflow-output>`)
}

function emitClarify(body: unknown): never {
  emitText(`<workflow-clarify nonce="${nonce}">${JSON.stringify(body)}</workflow-clarify>`)
}

function requirePrompt(needle: string): void {
  if (!prompt.includes(needle)) fail(`${agent} prompt missing expected content: ${needle}`, 10)
}

function writeFixture(relativePath: string, content: string): void {
  const absolute = join(process.cwd(), relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function batchCount(): number {
  const parsed = Number(prompt.match(/Your assignments \(batch of (\d+)\)/)?.[1] ?? '')
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${agent} prompt has no batch count`, 11)
  return parsed
}

// Every branch terminates through emitText()/fail(), both typed `never`.
// ESLint's syntactic no-fallthrough rule cannot infer those process exits.
/* eslint-disable no-fallthrough */
switch (agent) {
  case 'showcase-wg-lead': {
    requirePrompt('WG_MATRIX_CHARTER')
    requirePrompt('WG_MATRIX_GOAL literal {{do_not_expand}}')
    if (prompt.includes('## Completion gate REJECTED')) {
      requirePrompt('REVISE_AFTER_GATE_REJECTION')
      emitPorts({
        wg_assignments: JSON.stringify([
          {
            member: 'builder',
            title: 'implementation-v2',
            brief: 'Revise showcase/app.txt after the completion-gate feedback.',
          },
        ]),
        wg_decision: JSON.stringify({ action: 'continue' }),
      })
    }
    if (prompt.includes('implementation-v2 complete')) {
      emitPorts({
        wg_assignments: '[]',
        wg_decision: JSON.stringify({
          action: 'done',
          summary: 'leader-worker showcase revised and complete',
        }),
      })
    }
    if (
      prompt.includes('research complete') &&
      prompt.includes('implementation-code-v1 complete') &&
      prompt.includes('implementation-tests-v1 complete')
    ) {
      emitPorts({
        wg_assignments: '[]',
        wg_decision: JSON.stringify({
          action: 'done',
          summary: 'leader-worker showcase v1 complete',
        }),
      })
    }
    if (/\n## Clarify Q&A(?:\n|$)/.test(prompt)) {
      requirePrompt('blue-green')
      emitPorts({
        wg_assignments: JSON.stringify([
          {
            member: 'researcher',
            title: 'research-release',
            brief: 'Research the release constraints and report a concise result.',
          },
          {
            member: 'builder',
            title: 'implementation-v1-code',
            brief: 'Create showcase/app.txt with the v1 implementation.',
          },
          {
            member: 'builder',
            title: 'implementation-v1-tests',
            brief: 'Create showcase/tests.txt with independent v1 checks.',
          },
        ]),
        wg_messages: JSON.stringify([
          { to: 'builder', body: 'PRIVATE_BUILD_CONSTRAINT' },
          { to: null, body: 'PUBLIC_RELEASE_CONSTRAINT' },
        ]),
        wg_decision: JSON.stringify({ action: 'continue' }),
      })
    }
    emitClarify({
      questions: [
        {
          id: 'q-release-strategy',
          title: 'Choose the release strategy',
          kind: 'single',
          options: [{ label: 'blue-green', recommended: true }, { label: 'rolling' }],
        },
      ],
    })
  }

  case 'showcase-wg-researcher': {
    requirePrompt('Title: research-release')
    requirePrompt('WG_MATRIX_CHARTER')
    if (prompt.includes('WG_MATRIX_GOAL')) {
      fail('leader_worker worker unexpectedly received the group goal', 12)
    }
    emitPorts({
      wg_result: JSON.stringify({ summary: 'research complete' }),
    })
  }

  case 'showcase-wg-builder': {
    requirePrompt('WG_MATRIX_CHARTER')
    if (prompt.includes('WG_MATRIX_GOAL')) {
      fail('leader_worker worker unexpectedly received the group goal', 12)
    }
    if (prompt.includes('## Message turn')) {
      requirePrompt('PRIVATE_BUILD_CONSTRAINT')
      requirePrompt('PUBLIC_RELEASE_CONSTRAINT')
      emitPorts({ wg_messages: '[]' })
    }
    if (prompt.includes('Title: implementation-v2')) {
      requirePrompt('REVISE_AFTER_GATE_REJECTION')
      writeFixture('showcase/app.txt', 'implementation v2 after gate rejection\n')
      emitPorts({
        wg_result: JSON.stringify({ summary: 'implementation-v2 complete' }),
      })
    }
    if (prompt.includes('Title: implementation-v1-tests')) {
      requirePrompt('PRIVATE_BUILD_CONSTRAINT')
      requirePrompt('PUBLIC_RELEASE_CONSTRAINT')
      Bun.sleepSync(150)
      writeFixture('showcase/tests.txt', 'independent tests v1\n')
      emitPorts({
        wg_result: JSON.stringify({ summary: 'implementation-tests-v1 complete' }),
      })
    }
    if (prompt.includes('Title: implementation-v1-code')) {
      requirePrompt('PRIVATE_BUILD_CONSTRAINT')
      requirePrompt('PUBLIC_RELEASE_CONSTRAINT')
      Bun.sleepSync(150)
      if (!prompt.includes('## Protocol errors in your previous reply')) {
        // A syntactically valid envelope with the role-required result omitted.
        // The workgroup semantic parser must mint a protocol retry.
        emitPorts({ wg_messages: '[]' })
      }
      requirePrompt('wg_result')
      writeFixture('showcase/app.txt', 'implementation v1\n')
      emitPorts({
        wg_result: JSON.stringify({ summary: 'implementation-code-v1 complete' }),
      })
    }
    fail('unrecognized builder turn', 13)
  }

  case 'showcase-fc-alpha':
  case 'showcase-fc-beta': {
    requirePrompt('FC_MATRIX_CHARTER')
    requirePrompt('FC_MATRIX_GOAL literal {{fc_literal}}')
    if (prompt.includes('## Initial planning turn')) {
      if (agent === 'showcase-fc-alpha') {
        emitPorts({
          wg_result: JSON.stringify({ summary: 'alpha planning complete' }),
          wg_tasks_add: JSON.stringify([
            { title: 'FC shared duplicate', brief: 'one normalized duplicate' },
            { title: 'FC alpha task', brief: 'write the alpha artifact' },
          ]),
          wg_messages: JSON.stringify([
            { to: 'beta', body: 'FC_PRIVATE_SIGNAL' },
            { to: null, body: 'FC_PUBLIC_SIGNAL' },
          ]),
        })
      }
      emitPorts({
        wg_result: JSON.stringify({ summary: 'beta planning complete' }),
        wg_tasks_add: JSON.stringify([
          { title: 'fc-shared-duplicate!', brief: 'the same task after normalization' },
          { title: 'FC beta task', brief: 'write the beta artifact' },
        ]),
      })
    }
    if (prompt.includes('## Message turn')) {
      if (agent === 'showcase-fc-beta') requirePrompt('FC_PRIVATE_SIGNAL')
      requirePrompt('FC_PUBLIC_SIGNAL')
      emitPorts({
        wg_result: JSON.stringify({ summary: `${agent} consumed collaboration messages` }),
        wg_messages: '[]',
        wg_tasks_add: '[]',
      })
    }
    if (prompt.includes('## Your assignments (batch of')) {
      requirePrompt('FC_PUBLIC_SIGNAL')
      const count = batchCount()
      writeFixture(
        `showcase/${agent === 'showcase-fc-alpha' ? 'free-collab-alpha' : 'free-collab-beta'}.txt`,
        `${agent} completed ${count} task(s)\n`,
      )
      emitPorts({
        wg_task_results: JSON.stringify(
          Array.from({ length: count }, (_, index) => ({
            task: index + 1,
            summary: `${agent} batch task ${index + 1} complete`,
          })),
        ),
        wg_messages: '[]',
        wg_tasks_add: '[]',
      })
    }
    fail('unrecognized free-collab turn', 14)
  }

  case 'aw-workflow-orchestrator': {
    requirePrompt('DW_MATRIX_CHARTER')
    requirePrompt('DW_MATRIX_GOAL literal {{dw_goal_literal}}')
    requirePrompt('### member#1')
    requirePrompt('### member#2')
    const generated = prompt.includes('## Previous attempt was REJECTED')
      ? {
          nodes: [
            {
              id: 'dw_source',
              agentToken: 'member#1',
              promptTemplate: 'DW_LITERAL_SOURCE produce the implementation draft',
              inputs: [],
            },
            {
              id: 'dw_review',
              agentToken: 'member#2',
              promptTemplate: 'DW_REVIEW exactly once: {{draft}}',
              inputs: [
                {
                  port: 'draft',
                  from: { nodeId: 'dw_source', portName: 'draft' },
                },
              ],
            },
          ],
          edges: [],
        }
      : {
          nodes: [
            {
              id: 'dw_initial',
              agentToken: 'member#1',
              promptTemplate: 'DW_INITIAL_SINGLE produce one draft',
              inputs: [],
            },
          ],
          edges: [],
        }
    if (prompt.includes('## Previous attempt was REJECTED')) {
      requirePrompt('REGENERATE_WITH_REVIEWER')
    }
    emitPorts({ workflow: JSON.stringify(generated) })
  }

  case 'showcase-dw-source': {
    requirePrompt('DW_LITERAL_SOURCE')
    writeFixture('showcase/dynamic-source.txt', 'dynamic source produced\n')
    emitPorts({
      draft: 'draft-v2 literal {{must_stay_literal}}',
    })
  }

  case 'showcase-dw-reviewer': {
    requirePrompt('DW_REVIEW exactly once')
    requirePrompt('draft-v2 literal {{must_stay_literal}}')
    writeFixture('showcase/dynamic-review.txt', 'dynamic review passed\n')
    emitPorts({
      report: 'dynamic reviewer complete',
    })
  }

  default:
    fail(`unexpected agent '${agent}'`, 15)
}
/* eslint-enable no-fallthrough */
