// INTENT.md ↔ enforcement contract.
//
// The Codex implementation gate on this work produced three findings of the
// same shape (P2-3/4/5): the doc described a node form loosely enough that a
// model could follow it exactly and still emit a definition which APPLIES
// cleanly and then can never LAUNCH — a custom request with an object `body`,
// a `{{trigger.pull_request_number}}` that is not in the closed variable set, a
// call-workflow whose optional child input was left unwired.
//
// Tightening the prose fixed those three. Nothing, however, tied the prose to
// the code that enforces it — so the next change to a validator rule silently
// makes the doc wrong again, in precisely the way that is invisible until a
// user's task dies at launch.
//
// Every test here asserts BOTH halves at once:
//   1. INTENT.md states the rule (so the model is told), and
//   2. the enforcing code actually behaves that way (so being told is useful).
// Either half drifting turns the pair red. The rules are therefore asserted
// against the real predicates / validator, never restated as literals.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CODE_HOST_METHODS,
  CODE_HOST_REDACTED_FIELDS,
  INTENT_LIMITS,
  INTENT_REDACTED,
  SCRIPT_ENV_VALUE_PREFIX,
  SCRIPT_REDACTED_FIELDS,
  TRIGGER_CONTEXT_VARS,
  codeHostJsonBodyIssue,
  codeHostPathIssue,
  parseIntentChangeset,
  redactPrivilegedNodes,
  scriptDependencyIssue,
  scriptEnvSuffix,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { buildIntentDoc, INTENT_TURN_GUIDANCE } from '../src/services/intent/intentDoc'
import { validateWorkflowDef, type ValidatorContext } from '../src/services/workflow.validator'
import { assertScriptAuthorAllowed } from '../src/services/scriptAuthorGate'
import { assertCodeHostAuthorAllowed } from '../src/services/codeHostAuthorGate'

const NONCE = 'aabbccdd11223344'

const doc = buildIntentDoc({
  sessionTitle: 't',
  turns: [],
  currentDraftJson: null,
  validationErrors: [],
  pendingQuestions: [],
  hiddenDependencyNote: null,
  envelopeNonce: NONCE,
  langDirective: 'Write in the user’s language.',
  privileges: { mayAuthorScripts: true, mayAuthorCodeHostCalls: true },
})

/** The withheld-permission shape: the `Capability limits` section (and its
 *  OMIT instruction) only renders for an actor that may not author these. */
const withheldDoc = buildIntentDoc({
  sessionTitle: 't',
  turns: [],
  currentDraftJson: null,
  validationErrors: [],
  pendingQuestions: [],
  hiddenDependencyNote: null,
  envelopeNonce: NONCE,
  langDirective: 'Write in the user’s language.',
  privileges: { mayAuthorScripts: false, mayAuthorCodeHostCalls: false },
})

function ctx(over: Partial<ValidatorContext> = {}): ValidatorContext {
  return { agents: [], skills: [], ...over }
}

function codesOf(def: unknown, over: Partial<ValidatorContext> = {}): string[] {
  return validateWorkflowDef(def as WorkflowDefinition, ctx(over)).issues.map((i) => i.code)
}

function codeHostDef(node: Record<string, unknown>): unknown {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [{ id: 'ch1', kind: 'code-host-call', provider: 'gitlab', ...node }],
    edges: [],
  }
}

describe('RFC-273 single-turn guidance is not a parser limit', () => {
  test('INTENT.md teaches 8 ops / 6 workflow nodes / 256 KiB and a 9-op bundle remains valid', () => {
    expect(INTENT_TURN_GUIDANCE).toEqual({
      maxOps: 8,
      maxWorkflowNodesCreatedOrReplaced: 6,
      targetChangesetBytes: 256 * 1024,
    })
    expect(doc).toContain('Emit at most 8 changeset ops in one turn')
    expect(doc).toContain('at most 6 workflow nodes')
    expect(doc).toContain('Target at most 256 KiB')
    expect(doc).toContain('complete nonce-bound envelope')
    expect(INTENT_LIMITS.maxOps).toBeGreaterThan(INTENT_TURN_GUIDANCE.maxOps)

    const nineOps = {
      $schema_version: 1,
      ops: Array.from({ length: 9 }, (_, index) => ({
        opId: `op-${index + 1}`,
        action: 'create',
        resourceType: 'agent',
        tempRef: `$new:agent-${index + 1}`,
        payload: {
          name: `agent-${index + 1}`,
          description: '',
          outputs: ['result'],
          bodyMd: 'Do one thing.',
        },
      })),
    }
    expect(parseIntentChangeset(JSON.stringify(nineOps)).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Custom request: `path`
// ---------------------------------------------------------------------------
describe('contract: custom-request path rules', () => {
  test('doc states the leading-slash rule AND a bare path is rejected', () => {
    expect(doc).toContain('must start with a single `/`')
    expect(codeHostPathIssue('projects/1/merge_requests')).toBe('not-relative')
    expect(codeHostPathIssue('/projects/1/merge_requests')).toBeNull()
  })

  test('doc forbids a host AND an absolute URL is rejected', () => {
    expect(doc).toMatch(/a node can never name a host/)
    expect(codeHostPathIssue('https://evil.example/api')).toBe('has-scheme')
    expect(codeHostPathIssue('//evil.example/api')).toBe('protocol-relative')
  })

  test('doc forbids `?` / `#` AND both are rejected', () => {
    expect(doc).toContain('no `?`, no `#`')
    expect(codeHostPathIssue('/projects?per_page=5')).toBe('has-query')
    expect(codeHostPathIssue('/projects#frag')).toBe('has-query')
  })

  test('doc forbids `..` AND traversal is rejected, including percent-encoded', () => {
    expect(doc).toContain('no `..` segment')
    expect(codeHostPathIssue('/../../admin')).toBe('dot-dot')
    expect(codeHostPathIssue('/a/%2e%2e/b')).toBe('dot-dot')
    // ...but a segment that merely CONTAINS dots stays legal, so the doc's rule
    // is not over-broad either.
    expect(codeHostPathIssue('/a/..foo/b')).toBeNull()
  })

  test('doc forbids whitespace AND it is rejected', () => {
    expect(doc).toContain('no whitespace')
    expect(codeHostPathIssue('/pro jects')).toBe('whitespace')
  })

  test('the validator surfaces a bad path on a real node', () => {
    const codes = codesOf(
      codeHostDef({
        action: 'custom',
        params: {},
        request: { method: 'GET', path: 'projects/1' },
      }),
    )
    expect(codes).toContain('code-host-path-invalid')
  })
})

// ---------------------------------------------------------------------------
// Custom request: `method` and the destructive gate
// ---------------------------------------------------------------------------
describe('contract: custom-request method rules', () => {
  test('doc lists exactly the methods the schema accepts', () => {
    for (const method of CODE_HOST_METHODS) expect(doc).toContain(method)
    // and nothing outside the enum is taught
    for (const bogus of ['HEAD', 'OPTIONS', 'TRACE']) expect(doc).not.toContain(` ${bogus} `)
  })

  test('doc states the DELETE gate AND the validator enforces it', () => {
    expect(doc).toContain('allowDestructive:true')
    const withoutFlag = codesOf(
      codeHostDef({
        action: 'custom',
        params: {},
        request: { method: 'DELETE', path: '/projects/1' },
      }),
    )
    expect(withoutFlag).toContain('code-host-method-forbidden')

    const withFlag = codesOf(
      codeHostDef({
        action: 'custom',
        params: {},
        allowDestructive: true,
        request: { method: 'DELETE', path: '/projects/1' },
      }),
    )
    expect(withFlag).not.toContain('code-host-method-forbidden')
  })
})

// ---------------------------------------------------------------------------
// Custom request: `body`
// ---------------------------------------------------------------------------
describe('contract: custom-request body rules', () => {
  test('doc says body is a STRING of JSON AND an object body is refused', () => {
    expect(doc).toContain('`body` is a STRING holding JSON, not an object')
    const codes = codesOf(
      codeHostDef({
        action: 'custom',
        params: {},
        // the mistake a model makes by default
        request: { method: 'POST', path: '/x', body: { note: 'hi' } },
      }),
    )
    expect(codes).toContain('code-host-request-invalid')
  })

  test('doc says variables live INSIDE JSON strings AND the predicate agrees', () => {
    expect(doc).toMatch(/INSIDE a JSON string value \(never as a key, never bare\)/)
    expect(codeHostJsonBodyIssue('{"note":"{{findings}}"}')).toBeNull()
    expect(codeHostJsonBodyIssue('{"count":{{n}}}')?.kind).toBe('var-outside-string')
    expect(codeHostJsonBodyIssue('{{{key}}:"v"}')?.kind).toBeDefined()
  })

  test('a structurally broken body is refused', () => {
    expect(codeHostJsonBodyIssue('{"note":')?.kind).toBe('invalid-json')
    // an empty body stays legal (GET, or a POST with no payload)
    expect(codeHostJsonBodyIssue('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Trigger variables — the closed set
// ---------------------------------------------------------------------------
describe('contract: trigger variables are a closed set', () => {
  test('doc enumerates exactly the variables the validator accepts', () => {
    for (const name of TRIGGER_CONTEXT_VARS) expect(doc).toContain(name)
    expect(doc).toContain(`ONLY these ${TRIGGER_CONTEXT_VARS.length} names`)
  })

  test('an enumerated variable validates, an invented one does not', () => {
    const good = codesOf(
      codeHostDef({
        action: 'comment.create',
        params: { mr: '{{trigger.mr_iid}}', body: 'hi' },
      }),
    )
    expect(good).not.toContain('code-host-var-unknown')

    // exactly the plausible-but-wrong shape Codex called out
    const bad = codesOf(
      codeHostDef({
        action: 'comment.create',
        params: { mr: '{{trigger.pull_request_number}}', body: 'hi' },
      }),
    )
    expect(bad).toContain('code-host-var-unknown')
  })

  test('every documented name really is accepted (no stale entry in the list)', () => {
    for (const name of TRIGGER_CONTEXT_VARS) {
      const codes = codesOf(
        codeHostDef({
          action: 'comment.create',
          params: { mr: '1', body: `x {{trigger.${name}}} y` },
        }),
      )
      expect(codes, `trigger.${name} should be accepted`).not.toContain('code-host-var-unknown')
    }
  })
})

// ---------------------------------------------------------------------------
// Required params — doc markers vs validator enforcement
// ---------------------------------------------------------------------------
describe('contract: required action params', () => {
  test('a documented-required param really is required', () => {
    // `comment.create` needs `mr` and `body` on both providers.
    const missing = codesOf(codeHostDef({ action: 'comment.create', params: { mr: '1' } }))
    expect(missing).toContain('code-host-param-missing')

    const complete = codesOf(
      codeHostDef({ action: 'comment.create', params: { mr: '1', body: 'hi' } }),
    )
    expect(complete).not.toContain('code-host-param-missing')
  })

  test('an unsupported provider/action pair is refused, as the catalog says', () => {
    // thread.resolve is GitLab-only; the catalog marks github UNSUPPORTED.
    expect(doc).toMatch(/`thread\.resolve`.*github: UNSUPPORTED/)
    const codes = validateWorkflowDef(
      {
        $schema_version: 4,
        inputs: [],
        nodes: [
          {
            id: 'ch1',
            kind: 'code-host-call',
            provider: 'github',
            action: 'thread.resolve',
            params: { mr: '1', thread: 't' },
          },
        ],
        edges: [],
      } as unknown as WorkflowDefinition,
      ctx(),
    ).issues.map((i) => i.code)
    expect(codes).toContain('code-host-action-unsupported')
  })

  test('an action outside the registry is refused', () => {
    const codes = codesOf(codeHostDef({ action: 'not.a.real.action', params: {} }))
    expect(codes).toContain('code-host-action-invalid')
  })
})

// ---------------------------------------------------------------------------
// call-workflow launch rules
// ---------------------------------------------------------------------------
describe('contract: call-workflow input rules', () => {
  const child = (
    inputs: unknown[],
  ): { id: string; name: string; definition: WorkflowDefinition } => ({
    id: 'wf_child',
    name: 'child-flow',
    definition: {
      $schema_version: 4,
      inputs,
      nodes: [],
      edges: [],
      outputs: [],
    } as unknown as WorkflowDefinition,
  })

  function callerDef(edges: unknown[] = []): unknown {
    return {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'c1', kind: 'call-workflow', workflowName: 'child-flow' },
      ],
      edges,
    }
  }

  test('doc says EVERY child input needs an edge — including optional ones', () => {
    expect(doc).toMatch(/including inputs the child marks optional/)
    const optionalChild = child([{ kind: 'text', key: 'topic', label: 'Topic', required: false }])
    const codes = codesOf(callerDef(), {
      callWorkflows: new Map([
        ['child-flow', optionalChild],
        ['wf_child', optionalChild],
      ]),
    })
    expect(codes).toContain('call-workflow-input-unwired')
  })

  test('wiring that input clears the error', () => {
    const optionalChild = child([{ kind: 'text', key: 'topic', label: 'Topic', required: false }])
    const codes = codesOf(
      callerDef([
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'c1', portName: 'topic' },
        },
      ]),
      {
        callWorkflows: new Map([
          ['child-flow', optionalChild],
          ['wf_child', optionalChild],
        ]),
      },
    )
    expect(codes).not.toContain('call-workflow-input-unwired')
  })

  test('doc says an upload input makes the child uncallable AND the validator agrees', () => {
    expect(doc).toMatch(/CANNOT be called at all/)
    const uploadChild = child([{ kind: 'upload', key: 'docs', label: 'Docs', targetDir: 'in' }])
    const codes = codesOf(callerDef(), {
      callWorkflows: new Map([
        ['child-flow', uploadChild],
        ['wf_child', uploadChild],
      ]),
    })
    expect(codes).toContain('call-workflow-upload-input-unsupported')
  })
})

// ---------------------------------------------------------------------------
// Script node rules
// ---------------------------------------------------------------------------
describe('contract: script node rules the model cannot guess', () => {
  test('doc states the AW_PORT_ folding AND the implementation folds that way', () => {
    expect(doc).toContain('AW_PORT_<PORT>')
    expect(doc).toMatch(/uppercased, chars outside \[A-Z0-9_\] folded to/)
    expect(`${SCRIPT_ENV_VALUE_PREFIX}${scriptEnvSuffix('my-port')}`).toBe('AW_PORT_MY_PORT')
    expect(`${SCRIPT_ENV_VALUE_PREFIX}${scriptEnvSuffix('findings.json')}`).toBe(
      'AW_PORT_FINDINGS_JSON',
    )
  })

  test('doc demands exact version pins AND loose specs are rejected', () => {
    expect(doc).toContain('pkg==1.2.3')
    expect(scriptDependencyIssue('python', 'requests==2.32.3')).toBeNull()
    expect(scriptDependencyIssue('python', 'requests')).not.toBeNull()
    expect(scriptDependencyIssue('node', 'left-pad@1.3.0')).toBeNull()
    expect(scriptDependencyIssue('node', 'left-pad')).not.toBeNull()
  })

  test('doc says bash declares none AND bash deps are rejected', () => {
    expect(doc).toContain('bash declares none')
    expect(scriptDependencyIssue('bash', 'anything==1.0.0')).not.toBeNull()
  })

  test('doc says script nodes cannot sit in wrapper-fanout AND the validator agrees', () => {
    expect(doc).toContain('cannot sit inside wrapper-fanout')
    const codes = codesOf({
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'sc1', kind: 'script', language: 'bash', script: 'echo hi' },
        {
          id: 'fo1',
          kind: 'wrapper-fanout',
          nodeIds: ['sc1'],
          inputs: [{ name: 'shard', kind: 'list<string>', isShardSource: true }],
        },
      ],
      edges: [],
    })
    expect(codes).toContain('script-in-fanout-unsupported')
  })
})

// ---------------------------------------------------------------------------
// The three-way coupling this work introduced.
//
// The doc now tells the model to OMIT exactly the keys `mounted/` shows as
// `‹redacted›`, and the platform restores exactly the keys rehydration knows
// about. Three lists have to agree — the redactor's, the rehydrator's, and the
// doc's — and only the first two live next to each other. If the redactor ever
// masks a field the rehydrator does not restore, a permissionless author's
// faithful edit becomes an unexplainable 403.
// ---------------------------------------------------------------------------
describe('contract: redacted ⇄ rehydrated ⇄ documented are the same field sets', () => {
  const OPAQUE = { scripts: true, codeHost: true }

  function maskedKeysOf(node: Record<string, unknown>): string[] {
    const def = {
      $schema_version: 4,
      inputs: [],
      nodes: [node],
      edges: [],
    } as unknown as WorkflowDefinition
    const masked = redactPrivilegedNodes(def, OPAQUE, INTENT_REDACTED)
    const out = masked.nodes[0] as unknown as Record<string, unknown>
    return Object.keys(node).filter((k) => JSON.stringify(out[k]) !== JSON.stringify(node[k]))
  }

  test('a script node is masked in exactly SCRIPT_REDACTED_FIELDS', () => {
    const masked = maskedKeysOf({
      id: 'sc1',
      kind: 'script',
      language: 'python',
      script: 'print(1)',
      dependencies: ['requests==2.32.3'],
      env: { TOKEN: 'v' },
      readonly: true,
    })
    expect(masked.sort()).toEqual([...SCRIPT_REDACTED_FIELDS].sort())
  })

  test('a code-host node is masked in exactly CODE_HOST_REDACTED_FIELDS', () => {
    const masked = maskedKeysOf({
      id: 'ch1',
      kind: 'code-host-call',
      provider: 'gitlab',
      action: 'custom',
      params: { mr: '1' },
      request: { method: 'GET', path: '/x' },
      allowDestructive: false,
      timeoutMs: 1000,
    })
    expect(masked.sort()).toEqual([...CODE_HOST_REDACTED_FIELDS].sort())
  })

  test('the doc names those same keys as the ones to omit', () => {
    // The instruction lives in `Capability limits`, which only renders for an
    // actor who may not author these nodes — the only actor who is ever asked
    // to round-trip a redacted one.
    for (const field of [...SCRIPT_REDACTED_FIELDS, ...CODE_HOST_REDACTED_FIELDS]) {
      expect(withheldDoc).toContain(`\`${field}\``)
    }
    expect(withheldDoc).toMatch(/OMIT these WHOLE FIELDS/)
    expect(withheldDoc).toContain(INTENT_REDACTED)
  })

  test('enum fields survive redaction — masking them would break strict re-parse', () => {
    // privilegedNodeRedaction.ts's header states this explicitly: the validator
    // re-parses these nodes with the STRICT schemas, so a masked enum would
    // turn "you may not see this" into "the whole workflow fails validation".
    const masked = maskedKeysOf({
      id: 'sc1',
      kind: 'script',
      language: 'python',
      script: 'print(1)',
      readonly: true,
    })
    for (const kept of ['language', 'readonly', 'id', 'kind']) {
      expect(masked).not.toContain(kept)
    }
  })
})

// ---------------------------------------------------------------------------
// The last link of the redaction chain, held by a source-level assertion.
//
// The chain is: dumpBuilder masks → the model sees a marker → INTENT.md tells
// it which fields to omit → rehydration restores them. Links 2-4 are covered by
// value above. Link 1 is covered behaviourally in rfc234-dump-builder.test.ts,
// but that file asserts the marker as a STRING LITERAL — so changing
// INTENT_REDACTED would leave it green (matching the old literal) while the doc
// switched to the new value, and the model would be told to omit a marker it
// never sees. A source-level check is the cheap way to pin "same constant, not
// a coincidentally equal string" without standing up a second dump fixture.
// ---------------------------------------------------------------------------
describe('contract: the dump masks with the same constant the doc names', () => {
  const dumpSource = readFileSync(
    join(import.meta.dir, '..', 'src', 'services', 'intent', 'dumpBuilder.ts'),
    'utf8',
  )

  test('dumpBuilder redacts through the shared constant, not a literal', () => {
    expect(dumpSource).toContain('redactPrivilegedNodes')
    expect(dumpSource).toContain('INTENT_REDACTED')
    // a hardcoded marker would decouple the dump from the doc
    expect(dumpSource).not.toContain("'‹redacted›'")
  })

  test('dumpBuilder also masks script env before redacting', () => {
    // Two maskers compose here (RFC-253 T28 env carrier, then RFC-270's lens);
    // dropping either changes what the model sees without changing the doc.
    expect(dumpSource).toContain('maskWorkflowScriptEnv')
  })

  test('the doc quotes that same constant', () => {
    expect(withheldDoc).toContain(INTENT_REDACTED)
  })
})

// ---------------------------------------------------------------------------
// The one hand-written list left in the doc, bound to the gate that enforces it.
//
// Every other list INTENT.md renders is derived from a constant (actions from
// CODE_HOST_ACTION_DEFS, trigger vars from TRIGGER_CONTEXT_VARS, omissions from
// the *_REDACTED_FIELDS pairs). The "you can see it but may not edit it" list
// cannot be: it is the DIFFERENCE between the sensitive projection and the
// rehydrated set, and the projection's field list lives inside
// serializeScriptSensitiveProjectionV1 rather than in an exported constant.
//
// So bind it behaviourally instead: for each field the doc names, changing it
// must actually be refused by the gate. A field that drifts out of the
// projection would make the doc a liar (we forbid what is allowed); one that
// drifts in without being documented is caught by the reverse test below.
// ---------------------------------------------------------------------------
describe('contract: the see-but-do-not-touch list matches the gate', () => {
  const actor = {
    user: {
      id: 'u1',
      username: 'u1',
      displayName: 'u1',
      role: 'user' as const,
      status: 'active' as const,
    },
    source: 'session' as const,
    permissions: new Set<never>(),
  }
  const principal = { kind: 'actor' as const, actor: actor as never }

  const scriptNode = {
    id: 'sc1',
    kind: 'script',
    language: 'python',
    script: 'print(1)',
    outputs: [{ name: 'a' }],
    dependencies: ['requests==2.32.3'],
    env: {},
    readonly: true,
  }
  const codeHostNode = {
    id: 'ch1',
    kind: 'code-host-call',
    provider: 'gitlab',
    action: 'comment.create',
    params: { mr: '1', body: 'x' },
    allowDestructive: false,
    timeoutMs: 1000,
  }

  function defWith(node: Record<string, unknown>): WorkflowDefinition {
    return {
      $schema_version: 4,
      inputs: [],
      nodes: [node],
      edges: [],
    } as unknown as WorkflowDefinition
  }

  const scriptEdits: Array<[string, Record<string, unknown>]> = [
    ['language', { language: 'bash', dependencies: [] }],
    ['readonly', { readonly: false }],
    ['outputs', { outputs: [{ name: 'b' }] }],
  ]
  for (const [field, patch] of scriptEdits) {
    test(`script \`${field}\` is documented as untouchable AND the gate refuses it`, () => {
      expect(withheldDoc).toContain(`\`${field}\``)
      expect(() =>
        assertScriptAuthorAllowed({
          previous: defWith(scriptNode),
          next: defWith({ ...scriptNode, ...patch }),
          principal,
        }),
      ).toThrow()
    })
  }

  const codeHostEdits: Array<[string, Record<string, unknown>]> = [
    ['provider', { provider: 'github' }],
    ['action', { action: 'mr.approve' }],
    ['allowDestructive', { allowDestructive: true }],
    ['timeoutMs', { timeoutMs: 2000 }],
  ]
  for (const [field, patch] of codeHostEdits) {
    test(`code-host \`${field}\` is documented as untouchable AND the gate refuses it`, () => {
      expect(withheldDoc).toContain(`\`${field}\``)
      expect(() =>
        assertCodeHostAuthorAllowed({
          previous: defWith(codeHostNode),
          next: defWith({ ...codeHostNode, ...patch }),
          principal,
        }),
      ).toThrow()
    })
  }

  // The reverse direction: a field the gate DOES rehydrate must not appear in
  // the untouchable list, or we would be forbidding an edit the platform
  // silently discards anyway.
  test('rehydrated fields are never listed as untouchable', () => {
    const untouchableSection = withheldDoc.slice(
      withheldDoc.indexOf('editing any field you CAN see'),
      withheldDoc.indexOf('Apply is all-or-nothing'),
    )
    for (const field of [...SCRIPT_REDACTED_FIELDS, ...CODE_HOST_REDACTED_FIELDS]) {
      expect(untouchableSection).not.toContain(`\`${field}\``)
    }
  })
})
