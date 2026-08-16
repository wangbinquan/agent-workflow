// RFC-304 T51 — worked examples of the two scripts a department must supply.
//
// `collect` and `classify` are the platform's boundary with a pipeline it knows
// nothing about. Every organisation's CI reports differently, so the platform
// cannot ship the real implementations — but shipping NOTHING has a cost the
// design section names (§10-7): the first team to wire this up guesses at the
// contract from a Zod schema, gets a field wrong, and reads `blocked: the
// arbitration produced something its contract rejects` with no idea which field.
//
// So these exist to be copied and edited. They are held as source strings rather
// than as files on disk because that is how a script reaches the runner —
// `scripts_json` carries the text — and a sample stored in a shape the platform
// cannot actually run is a sample that silently stops matching.
//
// ## What they are NOT
//
// Not defaults. Nothing falls back to these: a cell with no `collect` is a
// configuration fault (see `resolveMonitorScripts`), because a monitor that
// invented its own view of a pipeline would arbitrate against a merge request
// it never read.
//
// ## Why the classifier is the interesting half
//
// `collect` is mostly an HTTP call to whatever the pipeline exposes, and the
// sample can only stub the shape. `classify` is pure text → structure, which is
// where the schema contract actually bites and where a mistake is invisible:
// producing zero issues from a failing log does not error, it just quietly
// arbitrates as though the pipeline had nothing wrong with it.

/**
 * The language these samples are written in; `scripts_json` needs it too.
 *
 * A `node` script is written to disk as `.mjs`, so it runs in ES module scope:
 * `import`, not `require`. Stated here because the mistake is silent in review
 * and loud only at runtime — `ReferenceError: require is not defined` from a
 * sample someone copied is a bad first experience of the feature.
 */
export const SAMPLE_SCRIPT_LANGUAGE = 'node' as const

/**
 * `collect` — what the platform knows about the merge request right now.
 *
 * Reads its input from `AW_CWI_INPUT_FILE` and writes one JSON object matching
 * `CollectResultSchema` to stdout.
 *
 * The `unknown` gate status is the line worth copying carefully: a pipeline the
 * script could not reach is NOT a failing pipeline. Reporting `fail` on a
 * timeout turns an outage in the CI system into a storm of repair rounds across
 * every open merge request at once — each of which then pushes a "fix" for a
 * failure that never happened.
 */
export const SAMPLE_COLLECT_SCRIPT = String.raw`#!/usr/bin/env node
// Sample \`collect\` for a self-hosted pipeline. Copy and edit.
import { readFileSync } from 'node:fs'

const inputFile = process.env.AW_CWI_INPUT_FILE
const input = inputFile ? JSON.parse(readFileSync(inputFile, 'utf8')) : {}

// Identity of what is being looked at, supplied by the platform. The anchor is
// a KIND plus an id — there is no project variable, because the platform does
// not know how your pipeline names projects. That comes from the script's own
// env overlay alongside the endpoint.
const anchorKind = process.env.AW_CWI_ANCHOR_KIND || ''
const anchorId = process.env.AW_CWI_ANCHOR_ID || ''
const project = process.env.PIPELINE_PROJECT || ''
const base = process.env.PIPELINE_API_BASE || ''

// The platform reads ONE port out of an envelope, not raw stdout. The nonce
// comes from the environment and must be echoed verbatim: it is what tells the
// platform this envelope came from the process it started, so anything the
// script happens to print that looks like an envelope cannot be mistaken for
// the result.
function emit(port, value) {
  const nonce = process.env.AW_ENVELOPE_NONCE || ''
  process.stdout.write(
    '<workflow-output nonce="' + nonce + '"><port name="' + port + '">' +
      JSON.stringify(value) +
      '</port></workflow-output>\n',
  )
}

async function main() {
  if (!base) {
    // No endpoint configured. Say so rather than guessing: the platform treats
    // a failed \`collect\` as "stop", which is right — there is nothing to
    // arbitrate against.
    process.stderr.write('PIPELINE_API_BASE is not set\n')
    process.exit(1)
  }

  if (anchorKind !== 'mr') {
    // A pipeline belongs to a merge request. An issue-anchored work item has no
    // pipeline to read, and inventing a \`pass\` for it would tell the monitor
    // everything is fine about something it never looked at.
    process.stderr.write('this collect only understands merge requests, not ' + anchorKind + '\n')
    process.exit(1)
  }

  let status = 'unknown'
  let runId
  let headSha = input.headSha || ''

  try {
    const url =
      base +
      '/projects/' +
      encodeURIComponent(project) +
      '/merge_requests/' +
      encodeURIComponent(anchorId) +
      '/latest'
    const res = await fetch(url, {
      headers: { authorization: 'Bearer ' + (process.env.PIPELINE_TOKEN || '') },
    })
    if (res.ok) {
      const body = await res.json()
      headSha = body.head_sha || headSha
      runId = body.run_id ? String(body.run_id) : undefined
      // Map the pipeline's vocabulary onto the platform's four words. Anything
      // this script does not recognise stays \`unknown\` — see the note above on
      // why an unreachable pipeline must never read as a failing one.
      if (body.state === 'succeeded') status = 'pass'
      else if (body.state === 'failed') status = 'fail'
      else if (body.state === 'running' || body.state === 'pending') status = 'running'
    }
  } catch (err) {
    process.stderr.write('could not reach the pipeline: ' + String(err) + '\n')
    process.exit(1)
  }

  if (!headSha) {
    process.stderr.write('no head sha: every later decision is about a revision\n')
    process.exit(1)
  }

  emit('collect', {
    conflict: Boolean(input.conflict),
    unresolvedComments: input.unresolvedComments || [],
    gate: runId ? { status, runId } : { status },
    headSha,
  })
}

main()
`

/**
 * `classify` — failure logs sorted into items a fix agent can act on.
 *
 * Reads the `collect` result plus the raw log from `AW_CWI_INPUT_FILE` and
 * writes a JSON array matching `ClassifiedIssuesSchema` to stdout.
 *
 * The patterns below are the ones this repository's own pipeline emits, because
 * a sample written against invented log formats teaches the wrong shape. Note
 * what the script does when it recognises nothing: it emits ONE item carrying
 * the tail of the log rather than an empty array. An empty array is a claim
 * that the pipeline is fine, which is the opposite of what a failing log means,
 * and it would arbitrate the round straight to `noop`.
 */
export const SAMPLE_CLASSIFY_SCRIPT = String.raw`#!/usr/bin/env node
// Sample \`classify\` for a self-hosted pipeline. Copy and edit.
import { readFileSync } from 'node:fs'

const inputFile = process.env.AW_CWI_INPUT_FILE
const input = inputFile ? JSON.parse(readFileSync(inputFile, 'utf8')) : {}
const log = String(input.log || '')

// The platform reads ONE port out of an envelope, not raw stdout. The nonce
// comes from the environment and must be echoed verbatim: it is what tells the
// platform this envelope came from the process it started, so anything the
// script happens to print that looks like an envelope cannot be mistaken for
// the result.
function emit(port, value) {
  const nonce = process.env.AW_ENVELOPE_NONCE || ''
  process.stdout.write(
    '<workflow-output nonce="' + nonce + '"><port name="' + port + '">' +
      JSON.stringify(value) +
      '</port></workflow-output>\n',
  )
}

const issues = []
const seen = new Set()

function add(issue) {
  // The fix agent reads this list; the same error repeated 40 times by a
  // compiler that re-reports per import site is 40 identical prompts' worth of
  // noise around one problem.
  const key = issue.type + '|' + (issue.file || '') + '|' + issue.message
  if (seen.has(key)) return
  seen.add(key)
  issues.push(issue)
}

for (const line of log.split('\n')) {
  // tsc:    src/a.ts(12,5): error TS2322: Type 'string' is not assignable ...
  let m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/.exec(line)
  if (m) {
    add({
      type: 'compile',
      file: m[1],
      line: Number(m[2]),
      message: m[4] + ': ' + m[5],
      raw: line,
    })
    continue
  }

  // eslint:  /abs/path/src/a.ts
  //            12:5  error  'x' is defined but never used  no-unused-vars
  m = /^\s+(\d+):(\d+)\s+error\s+(.+?)\s\s+([a-z@][\w@/-]*)$/.exec(line)
  if (m) {
    add({ type: 'codecheck', line: Number(m[1]), message: m[4] + ': ' + m[3], raw: line })
    continue
  }

  // bun test:  (fail) some suite > some case [12.34ms]
  m = /^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/.exec(line)
  if (m) {
    add({ type: 'unit-test', message: m[1], raw: line })
    continue
  }
}

if (issues.length === 0 && log.trim() !== '') {
  // Recognised nothing, but the pipeline is red. An empty array would claim it
  // is fine and arbitrate this round to \`noop\`; the fix agent can still work
  // from the raw tail, and a human reading the round sees why it was vague.
  const tail = log.trim().split('\n').slice(-40).join('\n')
  add({ type: 'unclassified', message: 'the pipeline failed and no pattern matched', raw: tail })
}

emit('classify', issues)
`

/**
 * The scripts as `scripts_json` would carry them, ready to paste into a cell.
 *
 * Exported as one object so a UI or a doc page cannot show a sample whose name
 * does not match the slot it belongs in — the mistake that produces "no
 * `collect` script is configured" while a perfectly good one sits in the cell
 * under the wrong key.
 */
export const SAMPLE_MONITOR_SCRIPTS: Readonly<
  Record<'collect' | 'classify', { language: typeof SAMPLE_SCRIPT_LANGUAGE; script: string }>
> = {
  collect: { language: SAMPLE_SCRIPT_LANGUAGE, script: SAMPLE_COLLECT_SCRIPT },
  classify: { language: SAMPLE_SCRIPT_LANGUAGE, script: SAMPLE_CLASSIFY_SCRIPT },
}
