// RFC-253 §2.2 — turning a script's stdout into port values.
//
// Two modes, decided by one observable fact (did the author declare `outputs`?):
//
//   single   — the port value IS the raw stdout, byte for byte. NOT the joined
//              line stream: the line pump drops empty lines and the trailing
//              newline, so `a\n\nb\n` would silently become `a\nb`
//              (design-gate F8).
//   envelope — the same `<workflow-output nonce=…>` protocol agents speak, so
//              downstream nodes cannot tell a script apart from an agent.
//
// The nonce is mandatory in envelope mode. What it defends against is precise
// and worth stating so nobody over-claims it: a script that echoes an upstream
// port value (`print(os.environ['AW_PORT_DIFF'])`) would otherwise let content
// that arrived from an upstream agent — content an attacker may have
// influenced — forge an envelope and dictate this node's outputs. It does NOT
// defend against the script's own author, who can read `AW_ENVELOPE_NONCE`
// and emit whatever they like; that is not a threat, it is the feature.

import {
  declaredScriptOutputs,
  scriptOutputMode,
  SCRIPT_DEFAULT_OUTPUT_PORT,
  type ScriptFailureCode,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { extractLastEnvelope, parseEnvelope } from './envelope'

export type ScriptPortExtraction =
  | { kind: 'ok'; ports: Record<string, string> }
  | { kind: 'failed'; code: ScriptFailureCode; detail: string }

export function extractScriptPorts(input: {
  node: WorkflowNode
  rawStdout: string
  nonce: string
}): ScriptPortExtraction {
  if (scriptOutputMode(input.node) === 'single') {
    return { kind: 'ok', ports: { [SCRIPT_DEFAULT_OUTPUT_PORT]: input.rawStdout } }
  }

  const declared = declaredScriptOutputs(input.node).map((p) => p.name)
  const envelope = extractLastEnvelope(input.rawStdout, input.nonce)
  if (envelope === null) {
    return {
      kind: 'failed',
      code: 'script-envelope-missing',
      detail:
        "no <workflow-output> envelope carrying this run's nonce was found on stdout; " +
        'emit <workflow-output nonce="$AW_ENVELOPE_NONCE">…</workflow-output>',
    }
  }

  const parsed = parseEnvelope(envelope, declared, input.nonce)

  // The parser reports framing corruption separately and does NOT fail on it —
  // the caller has to decide. Corruption outranks a missing port because a
  // mangled envelope makes every port after it untrustworthy.
  if (parsed.malformedPorts.length > 0) {
    return {
      kind: 'failed',
      code: 'script-envelope-malformed',
      detail: `malformed port framing: ${parsed.malformedPorts.join(', ')}`,
    }
  }
  // A missing declared port comes back as an empty string plus an entry in
  // `missingDeclared`; without this check the node would quietly succeed with
  // blank outputs (design-gate F9).
  if (parsed.missingDeclared.length > 0) {
    return {
      kind: 'failed',
      code: 'script-port-missing',
      detail: `declared ports absent from the envelope: ${parsed.missingDeclared.join(', ')}`,
    }
  }

  const ports: Record<string, string> = {}
  for (const [name, content] of parsed.ports) ports[name] = content
  return { kind: 'ok', ports }
}
