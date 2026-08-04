// RFC-254 T28b — `business-workgroups` mode: the port of `stub-opencode-business-workgroups.ts`.
//
// This one was ALREADY TypeScript, so the port is purely structural: the module
// body becomes a `run(argv)` function and the argv it used to read from
// `process.argv` arrives as a parameter. Nothing else is touched — the branch
// logic, the exit codes and the emitted bytes are the original's, and
// `rfc254-stub-differential.test.ts` compares the two to prove it.
//
// It joins the compiled dispatcher for the same reason the shell stubs did:
// a `#!/usr/bin/env bun` shebang is not executable on Windows.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

export function run(argv: readonly string[]): void {
  function fail(message: string, code = 2): never {
    process.stderr.write(`stub-opencode-business-workgroups: ${message}\n`)
    process.exit(code)
  }

  if (argv.includes('--version') || argv[0] === 'version' || argv[0] === '-v') {
    process.stdout.write('stub-opencode business-workgroups\n')
    process.exit(0)
  }
  if (argv[0] !== 'run') fail(`unsupported mode: ${argv.join(' ') || '<none>'}`)

  const agentFlag = argv.indexOf('--agent')
  const agent = agentFlag >= 0 ? (argv[agentFlag + 1] ?? '') : ''
  if (agent.length === 0) fail('missing --agent')

  const separator = argv.indexOf('--')
  // RFC-254 T28b — the prompt is the SINGLE positional after `--`, so it is
  // indexed, not joined. `slice(separator + 1).join(' ')` happened to agree
  // while the layout had exactly one trailing argument, but it is the same
  // whole-argv fold that 191bc32c's regression turned into a mass e2e failure,
  // and `e2e-stub-argv-contract.test.ts` now refuses it. The golden replay
  // confirms this changed no observable behaviour.
  const prompt = separator >= 0 ? (argv[separator + 1] ?? '') : (argv[1] ?? '')
  const nonce = [...prompt.matchAll(/\bnonce="([^"]+)"/g)].at(-1)?.[1]
  if (nonce === undefined || nonce.length === 0) fail('prompt is missing the RFC-200 nonce', 3)

  const stateDir = process.env.BUSINESS_WORKGROUP_STATE_DIR
  if (stateDir === undefined || stateDir.length === 0) {
    fail('BUSINESS_WORKGROUP_STATE_DIR is required')
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

  function requirePrompt(needle: string): void {
    if (!prompt.includes(needle)) fail(`${agent} prompt missing expected content: ${needle}`, 10)
  }

  function writeArtifact(relativePath: string, content: string): void {
    const absolute = join(process.cwd(), relativePath)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }

  function batchTitles(): string[] {
    return [...prompt.matchAll(/^### Task \d+: (.+)$/gm)].map((match) => match[1] ?? '')
  }

  function fencedInputBodies(name: string): string[] {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return [
      ...prompt.matchAll(
        new RegExp(`<aw-input name="${escaped}"[^>]*>\\n([\\s\\S]*?)\\n<\\/aw-input>`, 'g'),
      ),
    ].map((match) => match[1] ?? '')
  }

  const ASSIGNMENT_BRIEFS = {
    'Freeze source schema':
      'Create migration/schema-map.md with the frozen source-to-target field mapping.',
    'Validate encrypted export':
      'Validate the encrypted export checksum and record the result in migration/export-validation.txt.',
    'Prepare rollback runbook':
      'Create migration/rollback-runbook.md with abort criteria and restore steps.',
  } as const

  if (agent !== 'business-migration-planner' && agent !== 'business-migration-risk-reviewer') {
    fail(`unexpected agent '${agent}'`, 11)
  }

  requirePrompt('BUSINESS_MIGRATION_CHARTER')
  requirePrompt('BUSINESS_MIGRATION_GOAL')
  requirePrompt('125000-record')
  requirePrompt('exact record-count match')

  if (prompt.includes('## Initial planning turn')) {
    if (agent === 'business-migration-planner') {
      emitPorts({
        wg_result: JSON.stringify({
          summary: 'Migration controls decomposed into three independently auditable cards.',
        }),
        wg_tasks_add: JSON.stringify([
          {
            title: 'Freeze source schema',
            brief: ASSIGNMENT_BRIEFS['Freeze source schema'],
          },
          {
            title: 'Validate encrypted export',
            brief: ASSIGNMENT_BRIEFS['Validate encrypted export'],
          },
          {
            title: 'Prepare rollback runbook',
            brief: ASSIGNMENT_BRIEFS['Prepare rollback runbook'],
          },
        ]),
        wg_messages: JSON.stringify([
          {
            to: null,
            body: 'MIGRATION_WINDOW: schema freeze, encrypted-export evidence, and rollback readiness are independent release controls.',
          },
        ]),
      })
    }
    emitPorts({
      wg_result: JSON.stringify({
        summary:
          'Risk reviewer confirmed the plan separates schema, export-integrity, and rollback controls.',
      }),
      wg_tasks_add: '[]',
      wg_messages: '[]',
    })
  }

  if (prompt.includes('## Message turn')) {
    emitPorts({
      wg_result: JSON.stringify({ summary: `${agent} acknowledged the migration-room update.` }),
      wg_tasks_add: '[]',
      wg_messages: '[]',
    })
  }

  if (prompt.includes('## Your assignments (batch of')) {
    const titles = batchTitles()
    if (titles.length === 0) fail('batch prompt contains no task headings', 12)
    const briefs = fencedInputBodies('assignment-brief')
    if (briefs.length !== titles.length) {
      fail(`batch prompt has ${titles.length} titles but ${briefs.length} fenced briefs`, 12)
    }
    for (const [index, title] of titles.entries()) {
      const expectedBrief = ASSIGNMENT_BRIEFS[title as keyof typeof ASSIGNMENT_BRIEFS]
      if (expectedBrief === undefined || briefs[index] !== expectedBrief) {
        fail(`batch prompt brief mismatch for '${title}': ${briefs[index] ?? '<missing>'}`, 12)
      }
    }

    const firstExportAttempt = titles.includes('Validate encrypted export') && titles.length > 1
    const results = titles.map((title, index) => {
      const task = index + 1
      switch (title) {
        case 'Freeze source schema':
          writeArtifact(
            'migration/schema-map.md',
            '# Frozen schema map\n\ncustomer_id -> customer_id\nemail -> encrypted_email\n',
          )
          return {
            task,
            status: 'done',
            summary: 'Source schema frozen and field mapping recorded.',
          }
        case 'Validate encrypted export':
          if (firstExportAttempt) {
            return {
              task,
              status: 'failed',
              summary:
                'Encrypted export checksum mismatched the manifest; only this validation card needs another attempt.',
            }
          }
          writeArtifact(
            'migration/export-validation.txt',
            'checksum=verified\ncipher=AES-256-GCM\nrecords=125000\n',
          )
          return {
            task,
            status: 'done',
            summary: 'Encrypted export checksum and record count verified on retry.',
          }
        case 'Prepare rollback runbook':
          writeArtifact(
            'migration/rollback-runbook.md',
            '# Rollback runbook\n\n1. Stop writes.\n2. Restore the pre-cutover snapshot.\n3. Verify customer counts.\n',
          )
          return {
            task,
            status: 'done',
            summary: 'Rollback abort criteria and restore steps recorded.',
          }
        default:
          fail(`unexpected business task '${title}'`, 13)
      }
    })

    emitPorts({
      wg_task_results: JSON.stringify(results),
      wg_tasks_add: '[]',
      wg_messages: JSON.stringify(
        firstExportAttempt
          ? [
              {
                to: null,
                body: 'MIGRATION_RETRY: checksum mismatch isolated to encrypted-export validation; completed sibling controls remain valid.',
              },
            ]
          : titles.includes('Validate encrypted export')
            ? [
                {
                  to: null,
                  body: 'MIGRATION_RECOVERED: encrypted-export validation passed on its dedicated retry.',
                },
              ]
            : [],
      ),
    })
  }

  fail(`unrecognized turn for '${agent}'`, 14)
}
