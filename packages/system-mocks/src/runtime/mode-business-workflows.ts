// RFC-254 T28b — `business-workflows` mode: the port of `stub-opencode-business-workflows.ts`.
//
// This one was ALREADY TypeScript, so the port is purely structural: the module
// body becomes a `run(argv)` function and the argv it used to read from
// `process.argv` arrives as a parameter. Nothing else is touched — the branch
// logic, the exit codes and the emitted bytes are the original's, and
// `rfc254-stub-differential.test.ts` compares the two to prove it.
//
// It joins the compiled dispatcher for the same reason the shell stubs did:
// a `#!/usr/bin/env bun` shebang is not executable on Windows.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

export function run(argv: readonly string[]): void {
  function fail(message: string, code = 2): never {
    process.stderr.write(`stub-opencode-business-workflows: ${message}\n`)
    process.exit(code)
  }

  if (argv.includes('--version') || argv[0] === 'version' || argv[0] === '-v') {
    process.stdout.write('stub-opencode business-workflows\n')
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

  const stateDir = process.env.BUSINESS_WORKFLOW_STATE_DIR
  if (stateDir === undefined || stateDir.length === 0) {
    fail('BUSINESS_WORKFLOW_STATE_DIR is required')
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

  function emitPorts(ports: Record<string, string>): never {
    const body = Object.entries(ports)
      .map(([name, value]) => `<port name="${name}">${value}</port>`)
      .join('\n')
    process.stdout.write(
      `${JSON.stringify({
        type: 'text',
        timestamp: Date.now(),
        part: {
          type: 'text',
          text: `<workflow-output nonce="${nonce}">\n${body}\n</workflow-output>`,
        },
      })}\n`,
    )
    process.exit(0)
  }

  function requirePrompt(needle: string): void {
    if (!prompt.includes(needle)) fail(`${agent} prompt missing expected content: ${needle}`, 10)
  }

  function promptInput(name: string): string {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return prompt.match(new RegExp(`<aw-input name="${escaped}"[^>]*>\\n([^\\n]*)`))?.[1] ?? ''
  }

  function promptInputBody(name: string): string {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return (
      prompt.match(
        new RegExp(`<aw-input name="${escaped}"[^>]*>\\n([\\s\\S]*?)\\n<\\/aw-input>`),
      )?.[1] ?? ''
    )
  }

  function workflowIteration(): number {
    const parsed = Number(prompt.match(/\biteration=(\d+)\b/)?.[1] ?? '0')
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
  }

  function writeFixture(relativePath: string, content: string): void {
    const absolute = join(process.cwd(), relativePath)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }

  function readFixture(relativePath: string): string {
    try {
      return readFileSync(join(process.cwd(), relativePath), 'utf-8')
    } catch {
      fail(`${agent} expected worktree file ${relativePath}`, 11)
    }
  }

  const MARKDOWN_BOUNDARY = '<!-- @@aw-doc-boundary@@ -->'

  // Every branch exits through emitPorts()/fail(), both typed `never`.
  // ESLint's syntactic no-fallthrough rule does not infer those process exits.
  /* eslint-disable no-fallthrough */
  switch (agent) {
    case 'business-fix-engineer': {
      requirePrompt('BUSINESS_FIX_IMPLEMENT')
      requirePrompt('round cents correctly and reject invalid subtotals')
      requirePrompt('NO_PUSH')
      const iteration = workflowIteration()
      if (iteration === 0) {
        writeFixture(
          'src/checkout.ts',
          [
            'export function calculateTotal(subtotalCents: number): number {',
            '  return Math.round(subtotalCents * 1.13)',
            '}',
            '',
          ].join('\n'),
        )
        writeFixture(
          'tests/checkout.contract.md',
          [
            '# Checkout total contract',
            '',
            '- Fractional tax cents are rounded to the nearest cent.',
            '- Negative and fractional cent inputs must be rejected.',
            '',
          ].join('\n'),
        )
        emitPorts({
          fix_summary:
            '# Repair round 1\nRounding corrected; validation contract recorded for audit.',
        })
      }

      const prior = readFixture('src/checkout.ts')
      if (!prior.includes('Math.round') || prior.includes('Number.isInteger')) {
        fail('second repair round did not inherit the first-round worktree', 12)
      }
      const blockedEvidence = readFixture('business-evidence/quality-gate.md')
      if (
        !blockedEvidence.includes('audit_status=needs-fix') ||
        !blockedEvidence.includes('test_status=failed') ||
        !blockedEvidence.includes('Negative or fractional cent inputs still lack') ||
        !blockedEvidence.includes('negative and fractional input cases do not throw')
      ) {
        fail('second repair round did not consume the first-round quality evidence', 12)
      }
      writeFixture(
        'src/checkout.ts',
        [
          'export function calculateTotal(subtotalCents: number): number {',
          '  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) {',
          "    throw new RangeError('subtotalCents must be a non-negative integer')",
          '  }',
          '  return Math.round(subtotalCents * 1.13)',
          '}',
          '',
        ].join('\n'),
      )
      writeFixture(
        'tests/checkout.contract.md',
        [
          '# Checkout total contract',
          '',
          '- Fractional tax cents are rounded to the nearest cent.',
          '- Negative and fractional cent inputs throw `RangeError`.',
          '- Zero and large integer subtotals remain supported.',
          '',
        ].join('\n'),
      )
      emitPorts({
        fix_summary:
          '# Repair round 2\nAdded non-negative integer admission guard and expanded regression contract.',
      })
    }

    case 'business-code-auditor': {
      requirePrompt('BUSINESS_FIX_AUDIT')
      requirePrompt('src/checkout.ts')
      requirePrompt('tests/checkout.contract.md')
      const source = readFixture('src/checkout.ts')
      const clean = source.includes('Number.isInteger') && source.includes('subtotalCents < 0')
      emitPorts(
        clean
          ? {
              audit_status: 'clean',
              audit_report: '# Audit clean\nRounding and invalid-input boundaries are covered.',
            }
          : {
              audit_status: 'needs-fix',
              audit_report:
                '# Audit finding\nNegative or fractional cent inputs still lack an admission guard.',
            },
      )
    }

    case 'business-test-runner': {
      requirePrompt('BUSINESS_FIX_TEST')
      requirePrompt('src/checkout.ts')
      requirePrompt('tests/checkout.contract.md')
      const source = readFixture('src/checkout.ts')
      const contract = readFixture('tests/checkout.contract.md')
      const passed =
        source.includes('Math.round') &&
        source.includes('Number.isInteger') &&
        source.includes('subtotalCents < 0') &&
        contract.includes('RangeError')
      emitPorts(
        passed
          ? {
              test_status: 'passed',
              test_report:
                '# Contract tests passed\nRounding, invalid input, zero and large totals are covered.',
            }
          : {
              test_status: 'failed',
              test_report:
                '# Contract test failure\nThe negative and fractional input cases do not throw yet.',
            },
      )
    }

    case 'business-quality-gate': {
      requirePrompt('BUSINESS_FIX_QUALITY_GATE')
      const auditStatus = promptInput('audit_status')
      const testStatus = promptInput('test_status')
      const auditReport = promptInputBody('audit_report')
      const testReport = promptInputBody('test_report')
      if (auditReport.length === 0 || testReport.length === 0) {
        fail('quality gate did not receive audit and test report bodies', 16)
      }
      const clean = auditStatus === 'clean' && testStatus === 'passed'
      const iteration = workflowIteration()
      const releaseBrief = clean
        ? '# Quality gate clean\nCode audit and contract tests passed in repair round 2.'
        : '# Quality gate blocked\nAudit and tests require a second repair round for invalid-input handling.'
      let priorEvidence = ''
      try {
        priorEvidence = readFileSync(
          join(process.cwd(), 'business-evidence/quality-gate.md'),
          'utf-8',
        ).trimEnd()
      } catch {
        // The first quality-gate run creates the evidence ledger.
      }
      writeFixture(
        'business-evidence/quality-gate.md',
        [
          ...(priorEvidence.length > 0 ? [priorEvidence, ''] : ['# Quality gate evidence', '']),
          `## Repair round ${iteration + 1}`,
          '',
          `audit_status=${auditStatus}`,
          `test_status=${testStatus}`,
          `quality_status=${clean ? 'clean' : 'needs-fix'}`,
          '',
          '### Audit report',
          auditReport,
          '',
          '### Test report',
          testReport,
          '',
          releaseBrief,
          '',
        ].join('\n'),
      )
      emitPorts({
        quality_status: clean ? 'clean' : 'needs-fix',
        release_brief: releaseBrief,
      })
    }

    case 'business-release-preparer': {
      requirePrompt('BUSINESS_FIX_RELEASE_PACKET')
      requirePrompt('src/checkout.ts')
      requirePrompt('tests/checkout.contract.md')
      requirePrompt('Quality gate clean')
      requirePrompt('NO_PUSH')
      const evidence = readFixture('business-evidence/quality-gate.md')
      if (
        !evidence.includes('## Repair round 1') ||
        !evidence.includes('audit_status=needs-fix') ||
        !evidence.includes('test_status=failed') ||
        !evidence.includes('Negative or fractional cent inputs still lack an admission guard.') ||
        !evidence.includes('The negative and fractional input cases do not throw yet.') ||
        !evidence.includes('## Repair round 2') ||
        !evidence.includes('audit_status=clean') ||
        !evidence.includes('test_status=passed') ||
        !evidence.includes('Rounding and invalid-input boundaries are covered.') ||
        !evidence.includes('Rounding, invalid input, zero and large totals are covered.')
      ) {
        fail('release packet did not receive the complete two-round quality ledger', 17)
      }
      emitPorts({
        release_brief: [
          '# Controlled release candidate',
          '',
          '## Repair round 1 — blocked',
          '- Audit: needs-fix — Negative or fractional cent inputs still lack an admission guard.',
          '- Contract tests: failed — negative and fractional input cases do not throw yet.',
          '',
          '## Repair round 2 — releasable',
          '- Audit: clean — rounding and invalid-input boundaries are covered.',
          '- Contract tests: passed — invalid input, zero and large totals are covered.',
          '',
          'Changed paths: src/checkout.ts and tests/checkout.contract.md.',
          'No push was executed.',
        ].join('\n'),
      })
    }

    case 'business-document-reviewer': {
      requirePrompt('BUSINESS_DOC_REVIEW')
      requirePrompt('RETENTION_OWNER_REQUIRED')
      const document = promptInput('document')
      const shardKey = promptInput('shard-key')
      if (document.length === 0 || document !== shardKey) {
        fail(`document shard mismatch: document=${document} shard=${shardKey}`, 13)
      }
      for (const sibling of [
        'docs/customer-policy.md',
        'docs/partner-policy.md',
        'docs/unsourced-policy.md',
      ]) {
        if (sibling !== document && prompt.includes(sibling)) {
          fail(`document shard leaked sibling path ${sibling} into ${document}`, 13)
        }
      }
      const body = readFixture(document)
      if (!body.includes('Source:')) fail(`${document} has no source declaration`, 14)
      emitPorts({
        finding: `# ${document}\nSource declared; publisher must add retention owner and legal approval.`,
      })
    }

    case 'business-compliance-aggregator': {
      requirePrompt('BUSINESS_DOC_AGGREGATE')
      const findings = promptInputBody('findings')
      const findingLines = findings.split('\n').map((line) => line.replace(/^\u200b/, ''))
      for (const document of ['docs/customer-policy.md', 'docs/partner-policy.md']) {
        const heading = `# ${document}`
        if (findingLines.filter((line) => line === heading).length !== 1) {
          fail(`aggregator expected exactly one finding for ${document}`, 18)
        }
      }
      if (
        findings.includes('docs/unsourced-policy.md') ||
        findings.split('Source declared; publisher must add retention owner').length - 1 !== 2
      ) {
        fail('aggregator received incomplete, duplicate, or cross-task findings', 18)
      }
      emitPorts({
        report:
          '# Compliance batch report\nBoth source documents were reviewed. Add a retention owner and legal approval evidence to every published document.',
      })
    }

    case 'business-document-publisher': {
      requirePrompt('BUSINESS_DOC_PUBLISH')
      requirePrompt('Both source documents were reviewed')
      const isRevision = prompt.includes('## Review Rejection')
      if (isRevision) {
        requirePrompt('name the retention owner and legal approval evidence')
        requirePrompt('## Prior Output')
        requirePrompt('# Customer notice v1')
        requirePrompt('Retention period: 30 days.')
        requirePrompt('- [ ] Retention owner and legal approval still missing.')
      }
      const version = isRevision ? 2 : 1
      const notice = [
        `# Customer notice v${version}`,
        '',
        '<!-- business-publish-path: published/customer-notice.md -->',
        '',
        'Source documents: customer-policy.md and partner-policy.md.',
        ...(isRevision
          ? ['Retention owner: Compliance Operations.', 'Legal approval: LEGAL-2026-042.']
          : ['Retention period: 30 days.']),
        '',
      ].join('\n')
      const checklist = [
        `# Compliance checklist v${version}`,
        '',
        '<!-- business-publish-path: published/compliance-checklist.md -->',
        '',
        '- [x] Source declarations reviewed.',
        ...(isRevision
          ? ['- [x] Retention owner named.', '- [x] Legal approval evidence recorded.']
          : ['- [ ] Retention owner and legal approval still missing.']),
        '',
      ].join('\n')
      writeFixture('drafts/customer-notice.md', notice)
      writeFixture('drafts/compliance-checklist.md', checklist)
      emitPorts({
        documents: `${notice}${MARKDOWN_BOUNDARY}\n${checklist}`,
      })
    }

    case 'business-document-releaser': {
      requirePrompt('BUSINESS_DOC_RELEASE')
      const publishedPaths: string[] = []
      if (prompt.includes('business-publish-path: published/customer-notice.md')) {
        const notice = readFixture('drafts/customer-notice.md')
        writeFixture('published/customer-notice.md', notice)
        publishedPaths.push('published/customer-notice.md')
      }
      if (prompt.includes('business-publish-path: published/compliance-checklist.md')) {
        const checklist = readFixture('drafts/compliance-checklist.md')
        writeFixture('published/compliance-checklist.md', checklist)
        publishedPaths.push('published/compliance-checklist.md')
      }
      if (publishedPaths.length === 0) fail('release received no accepted documents', 15)
      emitPorts({ published_paths: publishedPaths.join('\n') })
    }

    default:
      fail(`unrecognized agent: ${agent}`, 4)
  }
}
