// RFC-306 T37 — `branch` mode: the deterministic model stand-in for
// `e2e/rfc306-conditional-branching.spec.ts`.
//
// The whole point of the e2e is that the REAL daemon decides what runs: the
// scheduler, the envelope parser, node_run_outputs.active, the frontier and the
// trace query all stay in the path, and only the model process is replaced. So
// this stub does exactly one interesting thing — it emits a branch marker —
// and is otherwise as dumb as possible.
//
// Which branch closes is driven by a marker in the node's prompt (the
// `workflow-matrix` convention), NOT by the agent name: the spec must be able to
// flip the decision without editing agents, because "the other branch runs
// instead" is half of what the test proves.
//
//   RFC306_CLOSE:<port>[,<port>…]  emit every declared port, marking these
//                                  inactive with a fixed reason.
//   (no marker)                    emit every declared port normally.
//
// Declared ports are read back out of the framework's own protocol block rather
// than hardcoded, so a spec can change the workflow's ports without touching the
// stub — and a prompt that failed to carry the protocol block fails loudly here
// instead of silently producing an empty envelope.

import {
  emitPromptForContractTest,
  emitTextEvent,
  parseInvocation,
  requireOutputOpen,
} from './skeleton'

const NAME = 'stub-opencode-branch'

/** Ports the framework told this run to emit, in declaration order. */
function declaredPorts(prompt: string): string[] {
  const names: string[] = []
  // The protocol block's Format section lists one `<port name="X">…</port>` per
  // declared port; the bullet list above it repeats the names in prose.
  for (const m of prompt.matchAll(/<port name="([^"]+)">/g)) {
    const name = m[1] ?? ''
    if (name.length > 0 && !names.includes(name)) names.push(name)
  }
  return names
}

function closedPorts(prompt: string): Set<string> {
  const m = /RFC306_CLOSE:([A-Za-z0-9_,]+)/.exec(prompt)
  if (m === null) return new Set()
  return new Set(
    (m[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
}

export function run(argv: readonly string[]): void {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode branch\n')
    process.exit(0)
  }
  emitPromptForContractTest(call.prompt)
  const open = requireOutputOpen(call.prompt, NAME)

  const ports = declaredPorts(call.prompt)
  if (ports.length === 0) {
    process.stderr.write(`${NAME}: prompt carried no declared output ports\n`)
    process.exit(11)
  }
  const closed = closedPorts(call.prompt)
  const unknown = [...closed].filter((p) => !ports.includes(p))
  if (unknown.length > 0) {
    // A spec that names a port this node does not declare would otherwise
    // produce a confusing `branch-port-not-declared` failure attributed to the
    // agent; fail here with the actual cause.
    process.stderr.write(`${NAME}: RFC306_CLOSE names undeclared port(s): ${unknown.join(', ')}\n`)
    process.exit(12)
  }

  let body = `${open}\n`
  for (const port of ports) {
    body += closed.has(port)
      ? `  <port name="${port}" active="false">stub decided not to run ${port}</port>\n`
      : `  <port name="${port}">stub value for ${port}</port>\n`
  }
  body += '</workflow-output>'
  emitTextEvent(body)
  process.exit(0)
}
