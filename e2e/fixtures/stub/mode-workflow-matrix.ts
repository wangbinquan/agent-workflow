// RFC-254 T28b — `workflow-matrix` mode: the port of
// `stub-opencode-workflow-matrix.sh`, the deterministic model stand-in for
// `e2e/workflow-matrix.spec.ts`.
//
// The real daemon, scheduler, DB, wrapper scopes, worktrees and output parser
// all stay in the path; only the model process is replaced. Each example
// workflow carries a `MATRIX_*` marker in its prompt that selects one branch.
//
// Two things here are contracts rather than conveniences:
//   * the distinct EXIT CODES (4 / 9 / 10 / 11 / 12 / 13 / 14 / 15). They are
//     how a spec tells "the workflow drove the wrong prompt here" apart from
//     "this branch failed on purpose", so they are reproduced exactly;
//   * the `require*` assertions. They fire INSIDE the stub, which is the only
//     place that can see what the framework actually rendered — a spec asserting
//     on the final ports would pass a prompt that silently lost its context.

import {
  emitPromptForContractTest,
  emitTextEvent,
  ensureStateDir,
  parseInvocation,
  requireEnvelopeOpen,
  writeInventoryIfRequested,
} from './skeleton'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const NAME = 'stub-opencode-workflow-matrix'

/** Exit and say why, on the stub's own stderr channel. */
function die(code: number, message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

/**
 * The line FOLLOWING an `<aw-input name="...">` opening tag.
 *
 * The shell used `sed -n '/<aw-input name="X"/ { n; p; q; }'`: first match wins,
 * the value is the NEXT line, and a tag on the very last line yields nothing.
 */
function promptInput(prompt: string, name: string): string {
  const lines = `${prompt}\n`.split('\n')
  const at = lines.findIndex((line) => line.includes(`<aw-input name="${name}"`))
  return at === -1 ? '' : (lines[at + 1] ?? '')
}

/**
 * The loop iteration the framework stamped into the prompt.
 *
 * The shell ran a per-line `sed` substitution keyed on `iteration=<digits>` and
 * took the first line that matched. Its leading `.` `*` is GREEDY, so within
 * that line the LAST occurrence wins. No match anywhere ⇒ 0.
 */
function iterationOf(prompt: string): string {
  for (const line of `${prompt}\n`.split('\n')) {
    const match = /^.*iteration=(\d+)/.exec(line)
    if (match !== null) return match[1] ?? '0'
  }
  return '0'
}

/** First line starting with `task=`, with the prefix stripped. */
function taskOf(prompt: string): string {
  for (const line of `${prompt}\n`.split('\n')) {
    if (line.startsWith('task=')) return line.slice('task='.length)
  }
  return ''
}

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

export async function run(argv: readonly string[]): Promise<void> {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode workflow-matrix\n')
    process.exit(0)
  }
  emitPromptForContractTest(call.prompt)
  const open = requireEnvelopeOpen(call.prompt, NAME)
  const prompt = call.prompt

  // Compact, one line — deliberately unlike the `basic` stub's pretty form.
  writeInventoryIfRequested(
    '{"schemaVersion":1,"capturedAt":1700000000000,"agents":[],"skills":[],"mcps":[],"plugins":[]}\n',
  )

  const ports = (body: string): never => {
    emitTextEvent(`${open.output}${body}</workflow-output>`)
    process.exit(0)
  }
  const clarify = (questions: string): never => {
    emitTextEvent(`${open.clarify}${questions}</workflow-clarify>`)
    process.exit(0)
  }
  const require_ = (needle: string): void => {
    if (!prompt.includes(needle)) {
      die(10, `${NAME}: prompt missing expected content: ${needle}`)
    }
  }
  // Kept as the STRING it was written as, because it is also a filename:
  // `iteration=007` named `iter-007.txt` in the shell and `iter-7.txt` after a
  // `Number()` round-trip, and `workflow-matrix.spec.ts` asserts those paths.
  // Comparisons below go through `Number()` explicitly.
  const iteration = iterationOf(prompt)
  const iterationNumber = Number(iteration)

  if (prompt.includes('MATRIX_PROMPT_INPUTS')) {
    for (const needle of [
      'literal {{auto_text}}',
      'thorough',
      '## auto_text',
      'auto-appended',
      '## files',
      'docs/a.md',
      'docs/b.md',
      '## tags',
      '["api","docs"]',
      '## branch',
      '{"kind":"branch","ref":"main"}',
      'node=prompt_auditor',
      'iteration=0',
      'repo_count=1',
    ]) {
      require_(needle)
    }
    ports('<port name="report">prompt-input-context-ok</port>')
  }

  if (prompt.includes('MATRIX_UPLOAD_INPUT')) {
    // Both disk checks FIRST, then both prompt checks — the shell's order, and
    // the two branches have different exit codes (11 vs 10) that the specs read
    // as different diagnoses. Interleaving them silently swapped which one a
    // half-present upload reports.
    const uploads = ['matrix-uploads/one.md', 'matrix-uploads/two.md']
    for (const file of uploads) {
      if (!existsSync(file)) die(11, `missing uploaded file ${file}`)
    }
    for (const file of uploads) require_(file)
    ports('<port name="report">upload-roundtrip-ok</port>')
  }

  // RFC-262: the uploaded file must have REPLACED the committed `docs/a.md`,
  // not landed beside it. Disk first (that is the actual claim), prompt second
  // (the packed path must keep the original name so repo-internal references
  // still resolve). Exit codes mirror the branch above: 11 = disk wrong,
  // 10 = prompt wrong.
  if (prompt.includes('MATRIX_UPLOAD_OVERWRITE')) {
    if (!existsSync('docs/a.md')) die(11, 'missing overwritten file docs/a.md')
    const landed = readFileSync('docs/a.md', 'utf-8')
    if (!landed.includes('uploaded-overwrite')) {
      die(11, `docs/a.md was not overwritten (content: ${JSON.stringify(landed)})`)
    }
    if (existsSync('docs/a (1).md')) die(11, 'overwrite mode still wrote a renamed copy')
    require_('docs/a.md')
    ports('<port name="report">upload-overwrite-ok</port>')
  }

  if (prompt.includes('MATRIX_OUTPUT_KINDS')) {
    writeFile('matrix-generated/kinds/one.md', '# One file\n')
    writeFile('matrix-generated/kinds/two.md', '# Two file\n')
    ports(
      '<port name="text">plain-value</port>' +
        '<port name="markdown"># Inline document</port>' +
        '<port name="file">matrix-generated/kinds/one.md</port>' +
        '<port name="names">alpha\nbeta</port>' +
        '<port name="documents"># First document\n<!-- @@aw-doc-boundary@@ -->\n# Second document</port>' +
        '<port name="files">matrix-generated/kinds/one.md\nmatrix-generated/kinds/two.md</port>' +
        '<port name="done_signal">ignored-signal-body</port>',
    )
  }

  if (prompt.includes('MATRIX_SOURCE_A')) ports('<port name="part">alpha-fragment</port>')
  if (prompt.includes('MATRIX_SOURCE_B')) ports('<port name="part">beta-fragment</port>')
  if (prompt.includes('MATRIX_MERGE')) ports('<port name="answer">merged-alpha-beta</port>')

  if (prompt.includes('MATRIX_GIT_MUTATE')) {
    writeFile('matrix-generated/source.txt', 'generated source\n')
    writeFile('matrix-generated/docs/report.md', '# generated document\n')
    ports('<port name="note">git-mutation-complete</port>')
  }
  if (prompt.includes('MATRIX_GIT_SUMMARY'))
    ports('<port name="answer">git-summary-complete</port>')
  if (prompt.includes('MATRIX_GIT_NOOP')) ports('<port name="note">observed-without-changes</port>')

  if (prompt.includes('MATRIX_LOOP_EMPTY')) {
    ports(
      iterationNumber === 0
        ? '<port name="status">continue</port><port name="items">alpha\nbeta</port>'
        : '<port name="status"></port><port name="items">complete</port>',
    )
  }
  if (prompt.includes('MATRIX_LOOP_EQUALS')) {
    ports(
      iterationNumber === 0
        ? '<port name="status">continue</port><port name="items">alpha\nbeta</port>'
        : '<port name="status">done</port><port name="items">complete</port>',
    )
  }
  if (prompt.includes('MATRIX_LOOP_COUNT')) {
    ports(
      iterationNumber === 0
        ? '<port name="status">continue</port><port name="items">alpha\nbeta\ngamma</port>'
        : '<port name="status">done</port><port name="items">only-one</port>',
    )
  }
  if (prompt.includes('MATRIX_LOOP_EXHAUST')) {
    ports('<port name="status">continue</port><port name="items">still-pending</port>')
  }

  if (prompt.includes('MATRIX_NESTED_MUTATE')) {
    writeFile(`matrix-generated/nested/iter-${iteration}.txt`, `nested iteration ${iteration}\n`)
    ports('<port name="note">nested-mutation-complete</port>')
  }
  if (prompt.includes('MATRIX_NESTED_CHECK')) {
    ports(
      iterationNumber === 0
        ? '<port name="status">continue</port><port name="items">pending</port>'
        : '<port name="status">done</port><port name="items">complete</port>',
    )
  }

  if (prompt.includes('MATRIX_FANOUT_WORKER')) {
    const doc = promptInput(prompt, 'doc') || 'unknown'
    if (doc === 'docs/fail.md') die(9, `intentional fanout shard failure: ${doc}`)
    ports(`<port name="finding">finding:${doc}</port>`)
  }
  if (prompt.includes('MATRIX_FANOUT_MUTATE')) {
    const doc = promptInput(prompt, 'doc') || 'unknown'
    writeFile(`matrix-generated/fanout/${basename(doc, '.md')}.txt`, `generated from ${doc}\n`)
    ports(`<port name="finding">mutated:${doc}</port>`)
  }
  if (prompt.includes('MATRIX_FANOUT_AGG')) {
    ports('<port name="report">aggregated-fanout-report</port>')
  }
  if (prompt.includes('MATRIX_LOOP_FANOUT_AGG')) {
    ports(
      iterationNumber === 0
        ? '<port name="status">continue</port><port name="report">fanout-generation-0</port>'
        : '<port name="status">done</port><port name="report">fanout-generation-1</port>',
    )
  }

  if (prompt.includes('MATRIX_MIXED_DRAFT')) {
    if (prompt.includes('## Review Rejection')) {
      require_('preserve the clarified target and revise the implementation')
      require_('## Prior Output')
      require_('mixed-document-v1 target=staging')
      writeFile('matrix-generated/mixed/release.md', 'release v2\n')
      writeFile('matrix-generated/mixed/checks.md', 'checks v2\n')
      ports('<port name="answer">mixed-document-v2 target=staging</port>')
    }
    if (prompt.includes('Deployment target?')) {
      require_('## Clarify Q&A')
      writeFile('matrix-generated/mixed/release.md', 'release v1\n')
      writeFile('matrix-generated/mixed/checks.md', 'checks v1\n')
      ports('<port name="answer">mixed-document-v1 target=staging</port>')
    }
    clarify(
      '{"questions":[{"id":"q-mixed","title":"Deployment target?","kind":"single","recommended":true,"options":["staging","production"]}]}',
    )
  }

  if (prompt.includes('MATRIX_MIXED_AUDIT')) {
    const changed = promptInput(prompt, 'changed_file')
    const sharedGoal = promptInput(prompt, 'shared_goal')
    const shardKey = promptInput(prompt, 'shard-key')
    if (changed === '') die(15, 'missing mixed audit shard path')
    if (sharedGoal !== 'ship the reviewed release') die(15, 'missing mixed audit broadcast goal')
    if (shardKey !== changed) {
      die(15, `mixed audit shard-key mismatch: input=${changed} shard=${shardKey}`)
    }
    ports(`<port name="finding">audited:${changed}</port>`)
  }
  if (prompt.includes('MATRIX_MIXED_SUMMARY')) {
    require_('aggregated-fanout-report')
    require_('ship the reviewed release')
    ports('<port name="answer">mixed-release-summary</port>')
  }

  if (prompt.includes('MATRIX_SELF_CLARIFY')) {
    if (prompt.includes('Choose a delivery mode')) {
      ports('<port name="answer">self-clarify-complete</port>')
    }
    clarify(
      '{"questions":[{"id":"q-self","title":"Choose a delivery mode","kind":"single","recommended":true,"options":["safe","fast"]}]}',
    )
  }

  if (prompt.includes('MATRIX_CROSS_DESIGN')) ports('<port name="design">cross-design-v1</port>')
  if (prompt.includes('MATRIX_CROSS_QUESTION')) {
    if (prompt.includes('Which trade-off should win?')) {
      ports('<port name="answer">cross-clarify-complete</port>')
    }
    clarify(
      '{"questions":[{"id":"q-cross","title":"Which trade-off should win?","kind":"single","recommended":false,"options":["latency","consistency"]}]}',
    )
  }

  if (prompt.includes('MATRIX_REVIEW_WRITE')) {
    ports(
      prompt.includes('## Review Rejection')
        ? '<port name="answer">review-ready-document-v2</port>'
        : '<port name="answer">review-ready-document-v1</port>',
    )
  }

  if (prompt.includes('MATRIX_RUNTIME')) {
    const mode = promptInput(prompt, 'mode')
    const task = taskOf(prompt) || 'unknown'
    if (mode === 'retry') {
      // First attempt fails and leaves a marker; the framework's retry finds it
      // and succeeds. The marker lives outside the worktree because a retry
      // rolls the worktree back to its pre-run snapshot.
      const stateFile = join(ensureStateDir(process.env.MATRIX_STATE_DIR, '.'), `retry-${task}`)
      if (!existsSync(stateFile)) {
        writeFileSync(stateFile, '')
        die(12, 'intentional first-attempt failure')
      }
      ports('<port name="result">retry-recovered</port>')
    }
    if (mode === 'fail') die(13, 'intentional permanent runtime failure')
    if (mode === 'timeout' || mode === 'cancel') {
      await Bun.sleep(10_000)
      ports('<port name="result">unexpected-slow-completion</port>')
    }
    die(14, `unknown MATRIX_RUNTIME mode: ${mode}`)
  }

  die(4, `${NAME}: no MATRIX_* marker in prompt`)
}
