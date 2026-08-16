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
  scriptBranchPorts,
  scriptOutputMode,
  SCRIPT_DEFAULT_OUTPUT_PORT,
  type ScriptFailureCode,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { extractLastEnvelope, parseEnvelope } from './envelope'

export type ScriptPortExtraction =
  | {
      kind: 'ok'
      ports: Record<string, string>
      /**
       * RFC-306 — ports the script closed with `active="false"`. Always present
       * (empty in single-port mode, which never parses an envelope) so callers
       * cannot forget the distinction between "no branch closed" and "this shape
       * cannot express branches".
       */
      inactivePorts: string[]
    }
  | { kind: 'failed'; code: ScriptFailureCode; detail: string }

export function extractScriptPorts(input: {
  node: WorkflowNode
  rawStdout: string
  nonce: string
}): ScriptPortExtraction {
  if (scriptOutputMode(input.node) === 'single') {
    // Single-port mode is raw stdout — there is no envelope to carry a marker,
    // so a branch simply cannot be expressed here. The validator rejects
    // `branch: true` in this mode so the author finds out at save time rather
    // than watching a marker do nothing at run time.
    return {
      kind: 'ok',
      ports: { [SCRIPT_DEFAULT_OUTPUT_PORT]: input.rawStdout },
      inactivePorts: [],
    }
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

  // RFC-306 — same admission the runner applies to agents (design §3.5): a
  // malformed `active` value, or a marker on a port not declared `branch: true`,
  // is a hard failure rather than a silently-ignored marker. It is PERMANENT for
  // scripts (SCRIPT_PERMANENT_FAILURE_CODES): the declaration lives in the frozen
  // workflow definition, so retrying re-renders the identical mismatch.
  if (parsed.badActiveAttr.length > 0) {
    return {
      kind: 'failed',
      code: 'script-branch-port-not-declared',
      detail: `port(s) ${parsed.badActiveAttr.join(', ')} carry an \`active\` attribute whose value is neither "true" nor "false"`,
    }
  }
  const declaredBranch = new Set(scriptBranchPorts(input.node))
  const illegal = parsed.inactivePorts.filter((p) => !declaredBranch.has(p))
  if (illegal.length > 0) {
    return {
      kind: 'failed',
      code: 'script-branch-port-not-declared',
      detail:
        `port(s) ${illegal.join(', ')} marked active="false" but are not declared branch ports; ` +
        (declaredBranch.size > 0
          ? `declared branch ports: ${[...declaredBranch].join(', ')}`
          : 'this node declares no branch ports'),
    }
  }

  const ports: Record<string, string> = {}
  for (const [name, content] of parsed.ports) ports[name] = content
  return { kind: 'ok', ports, inactivePorts: parsed.inactivePorts }
}
