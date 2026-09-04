// RFC-348 D1 — the node-kind teaching registry: one entry per `NodeKind`,
// compile-checked against `{ [K in NodeKind]: NodeTeachingOf<K> }` (types.ts).
//
//  - Adding a kind to `NODE_KIND` fails to compile until it is registered here.
//  - The eight kinds with a strict zod schema derive their field table from that
//    schema: a new top-level, nested, array-element or variant field fails to
//    compile until it is taught (or explicitly `omit`ted with a reason).
//  - The five passthrough kinds (no dedicated schema) declare their authorable
//    fields as literal unions in types.ts and MUST name a real read point per
//    field (`fieldSources`); tests/intent-teaching-registry.test.ts verifies
//    those against the TypeScript AST in both directions.
//  - `code-round` is synthesized-only: registered so the doc can NAME it as
//    withheld (RFC-304), with no field table at all.
//
// Every sentence the model reads about a node kind lives here; the renderer
// (render.ts) only assembles. Contract-locked phrases (rfc234-intent-doc /
// intent-doc-validator-contract tests) are kept verbatim.

import {
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_OUTPUT_PORT_NAME,
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  CODE_HOST_METHODS,
  CODE_HOST_REDACTED_FIELDS,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
  INTENT_REDACTED,
  LOOP_EXIT_CONDITION_KINDS,
  SCRIPT_REDACTED_FIELDS,
  type NodeKind,
} from '@agent-workflow/shared'
import type { NodeTeachingOf } from './types'

const VALIDATOR =
  'packages/backend/src/modules/resource-catalog/infrastructure/legacy/workflow.validator.ts'
const RESOLVE_SEAM = 'packages/backend/src/modules/intent/application/resolveChangeset.ts'

const LIMITS_TEACHING = {
  maxDurationMs: { form: 'maxDurationMs', required: false },
  maxTotalTokens: { form: 'maxTotalTokens', required: false },
} as const

export const INTENT_NODE_TEACHING = {
  input: {
    availability: { kind: 'public' },
    fields: { inputKey: { form: 'inputKey', required: true } },
    fieldSources: { inputKey: { readPoint: { file: VALIDATOR, identifier: 'inputKey' } } },
    notes: [],
    mistakes: [],
  },
  'agent-single': {
    availability: { kind: 'public' },
    fields: {
      agentRef: { form: 'agentRef:ref', required: true },
      promptTemplate: { form: 'promptTemplate', required: true },
    },
    fieldSources: {
      agentRef: { intentOnly: { resolvedIn: RESOLVE_SEAM } },
      promptTemplate: { readPoint: { file: VALIDATOR, identifier: 'promptTemplate' } },
    },
    notes: ['Use `agentRef`, never agentId/agentName.'],
    mistakes: [
      'An agent-single node carrying `agentId` or `agentName` is rejected before validation — the only agent selector is `agentRef` (a `res#agent#n` handle or a `$new:` tempRef).',
    ],
  },
  output: {
    availability: { kind: 'public' },
    // RFC-354 (schema v6): an output node's ports ARE its inbound edges — the
    // edge's target port name is the task output name; nothing is declared.
    fields: {},
    fieldSources: {},
    notes: [
      'An `output` node declares nothing: every edge into it is one task output, named by the edge target port; connect the producing port to the output node.',
    ],
    mistakes: [],
  },
  'wrapper-git': {
    availability: { kind: 'public' },
    fields: { nodeIds: { form: 'nodeIds:[nodeId]', required: true } },
    fieldSources: { nodeIds: { readPoint: { file: VALIDATOR, identifier: 'nodeIds' } } },
    notes: [
      "Its only output is `git_diff:list<path<*>>`. An inbound edge into the wrapper declares a parameter (the edge target port is the parameter name) that inner nodes read through a `boundary:'wrapper-input'` edge; an edge from outside straight into an inner node is a closure (RFC-354).",
    ],
    mistakes: [],
  },
  'wrapper-loop': {
    availability: { kind: 'public' },
    fields: {
      nodeIds: { form: 'nodeIds:[nodeId]', required: true },
      maxIterations: { form: 'maxIterations', required: true },
      exitCondition: {
        form: `exitCondition:{kind:${LOOP_EXIT_CONDITION_KINDS.map((kind) => `'${kind}'`).join('|')},portName,value?,n?,separator?}`,
        required: true,
        note: "The predicate reads the loop's OWN return port (`portName` names one of its `boundary:'wrapper-output'` edges). Fields by kind: `port-equals` needs `value`, `port-count-lt` needs `n` (plus an optional `separator`), `port-inactive` (RFC-306) is met when the promoted port was inactive this iteration; the other kinds need only `portName`.",
      },
      continueOnMaxIterations: {
        form: 'continueOnMaxIterations',
        required: false,
        note: "`continueOnMaxIterations:true` (RFC-236) lets the workflow carry on when the loop hits `maxIterations` without meeting the exit condition (the last iteration's outputs stand); the default `false` fails the task as exhausted.",
      },
    },
    fieldSources: {
      nodeIds: { readPoint: { file: VALIDATOR, identifier: 'nodeIds' } },
      maxIterations: { readPoint: { file: VALIDATOR, identifier: 'maxIterations' } },
      exitCondition: {
        readPoint: {
          file: 'packages/backend/src/modules/task-execution/engine/wrapper/loopStrategy.ts',
          identifier: 'exitCondition',
        },
      },
      continueOnMaxIterations: {
        readPoint: {
          file: 'packages/shared/src/loopPolicy.ts',
          identifier: 'continueOnMaxIterations',
        },
      },
    },
    notes: [
      "Return values are `boundary:'wrapper-output'` edges from a direct body node to the loop (edge target port = return port name); `exitCondition.portName` must be one of them (RFC-354).",
    ],
    mistakes: [
      'A `wrapper-output` edge must start at a DIRECT member of the loop (listed in its `nodeIds`); an exit condition naming a port with no such edge does not validate.',
    ],
  },
  'wrapper-fanout': {
    availability: { kind: 'public' },
    fields: {
      nodeIds: { form: 'nodeIds:[nodeId]', required: true },
      shardSourcePort: { form: 'shardSourcePort', required: true },
      expectedShardCount: { form: 'expectedShardCount', required: false },
    },
    notes: [
      "Parameters are the wrapper's inbound edges (edge target port = parameter name); `shardSourcePort` names the one whose `list<T>` source is sharded, every other parameter is broadcast (RFC-354). v1 inner nodes are agent-single only; at most one inner agent may have payload `role:'aggregator'`. Worker→aggregator is an ordinary inner edge; the runtime groups every shard's worker output into that aggregator input. Never target the aggregator with a `boundary:'wrapper-input'` edge — runtime intentionally does not inject wrapper inputs into aggregators. Aggregator outputs are promoted through `boundary:'wrapper-output'` edges to wrapper outlets (same name unless the aggregator payload maps it with `outputWrapperPortNames`).",
    ],
    mistakes: [],
  },
  review: {
    availability: { kind: 'public' },
    fields: {
      rerunnableOnReject: { form: 'rerunnableOnReject:[nodeId]', required: true },
      rerunnableOnIterate: { form: 'rerunnableOnIterate:[nodeId]', required: true },
      rollbackFilesOnReject: { form: 'rollbackFilesOnReject', required: false },
      rollbackFilesOnIterate: { form: 'rollbackFilesOnIterate', required: false },
      commentInjectTemplate: { form: 'commentInjectTemplate', required: false },
      description: { form: 'description', required: false },
      assignee: {
        omit: true,
        why: 'reserved schema slot; the UI does not surface it (schemas/review.ts)',
      },
    },
    notes: [
      'The reviewed source is the ONE edge into the review node targeting `__review_input__` (RFC-354: no `inputSource` field); approved single-document output ports are `approved_doc` and `approval_meta`. A comment template may use only `{{__review_comments__}}` plus canonical webhook trigger refs.',
    ],
    mistakes: [
      // RFC-358 §11 —— 本机生产库快照里，意图产出的工作流唯一带 error 的那一个就是这条
      // （review 的被审源接在 wrapper-fanout 上）。它属于图校验才知道的规则家族。
      'The reviewed source must come from an AGENT node whose port kind is markdown-ish — wiring a wrapper (fanout/loop/git) outlet or an input node into `__review_input__` does not validate.',
    ],
  },
  clarify: {
    availability: { kind: 'public' },
    fields: {
      description: { form: 'description', required: false },
      sessionMode: { form: "sessionMode:'isolated'|'inline'", required: false },
      clarifyMode: { form: "clarifyMode:'optional'", required: false },
      assignee: {
        omit: true,
        why: 'reserved schema slot; the UI does not surface it (schemas/workflow.ts)',
      },
    },
    notes: [
      `Fixed ports: inbound \`${CLARIFY_INPUT_PORT_NAME}\` (wire the asking agent's \`${CLARIFY_SOURCE_PORT_NAME}\` port to it), outbound \`${CLARIFY_OUTPUT_PORT_NAME}\` (wire it back to that agent's \`${CLARIFY_RESPONSE_TARGET_PORT_NAME}\` port).`,
    ],
    mistakes: [
      // RFC-358 D1 —— 图校验的 warning 不进 INTENT.md（它们是给人的提醒），所以这里是
      // 模型唯一能学到它们的地方。这两条是最会反复复发的。
      'A clarify node outside a wrapper-loop has no iteration cap — the agent may keep asking indefinitely. Put it inside a wrapper-loop with `max_iterations` unless the user explicitly wants an uncapped exchange.',
      `Leaving the \`${CLARIFY_OUTPUT_PORT_NAME}\` port unwired means the answers never reach the agent that asked; wire it back to that agent.`,
    ],
  },
  'clarify-cross-agent': {
    availability: { kind: 'public' },
    fields: {
      description: { form: 'description', required: false },
      sessionModeForQuestioner: {
        form: "sessionModeForQuestioner:'isolated'|'inline'",
        required: false,
      },
      assignee: {
        omit: true,
        why: 'reserved schema slot; the UI does not surface it (schemas/workflow.ts)',
      },
    },
    notes: [
      `Fixed ports: inbound \`${CROSS_CLARIFY_INPUT_PORT_NAME}\` (from the questioner agent's \`${CLARIFY_SOURCE_PORT_NAME}\` port), outbound \`${CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT}\` (back to the questioner's \`${CLARIFY_RESPONSE_TARGET_PORT_NAME}\` port, automatic) and \`${CROSS_CLARIFY_OUT_TO_DESIGNER_PORT}\` (wire it manually to the designer agent's \`${CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT}\` port).`,
    ],
    mistakes: [],
  },
  'call-workflow': {
    availability: { kind: 'public' },
    fields: {
      workflowName: { form: "workflowName:'<exact target name>'", required: true },
      workflowRef: {
        form: 'workflowRef',
        required: false,
        note: '`workflowRef` (a `res#workflow#n` handle or a `$new:` tempRef) pins WHICH row the name binds to — see Reference rules.',
      },
      workflowId: { omit: true, why: 'canonical ULID cache — model-forbidden (RFC-291 面 E)' },
      limits: {
        form: 'limits:{maxDurationMs?,maxTotalTokens?}',
        required: false,
        nested: LIMITS_TEACHING,
      },
    },
    notes: [
      "Runs ANOTHER workflow as an independent child task. Its ports MIRROR that child's declared inputs (in-ports) and outputs (out-ports), so you can only wire it correctly where you can actually read them: a workflow under `mounted/`, or one you create in this same changeset. For a workflow you only see summarized in inventory/, ask the user to mount it instead of guessing port names. Two launch-time rules the definition alone will not tell you: EVERY one of the child's declared inputs needs its own ordinary incoming edge targeting that exact input key — including inputs the child marks optional, else `call-workflow-input-unwired`; and a child that declares any `upload` input CANNOT be called at all (`call-workflow-upload-input-unsupported`), so pick a different composition rather than emitting a caller that can never launch.",
    ],
    mistakes: [
      '`workflowRef` / `workgroupRef` travel WITH `workflowName` / `workgroupName`, never instead of them; a node carrying `workflowId` / `workgroupId` is rejected.',
    ],
  },
  'call-workgroup': {
    availability: { kind: 'public' },
    fields: {
      workgroupName: { form: "workgroupName:'<exact target name>'", required: true },
      workgroupRef: {
        form: 'workgroupRef',
        required: false,
        note: '`workgroupRef` (a `res#workgroup#n` handle or a `$new:` tempRef) pins WHICH row the name binds to — see Reference rules.',
      },
      workgroupId: { omit: true, why: 'canonical ULID cache — model-forbidden (RFC-291 面 E)' },
      goalTemplate: { form: 'goalTemplate', required: true },
      limits: {
        form: 'limits:{maxDurationMs?,maxTotalTokens?}',
        required: false,
        nested: LIMITS_TEACHING,
      },
    },
    notes: [
      "Hands this stage to a workgroup running as an independent child task. Inbound ports are edge-derived (each incoming edge's target portName IS the variable name) and readable inside `goalTemplate` as `{{port_name}}`; the single output port is `result`.",
    ],
    mistakes: [],
  },
  script: {
    availability: {
      kind: 'privileged',
      permission: 'scripts:author',
      redactedFields: SCRIPT_REDACTED_FIELDS,
      overviewLabel: 'script (inline code, no model)',
      nestedRedactionHint: `a redacted \`env\` prints as \`{"NAME": "${INTENT_REDACTED}"}\` — drop the whole \`env\`, not just the value`,
      untouchableFields: '`language` / `readonly` / `outputs`',
    },
    fields: {
      language: { form: "language:'python'|'bash'|'node'", required: true },
      script: { form: 'script', required: true },
      outputs: {
        form: 'outputs:[{name,kind?,branch?}]',
        required: false,
        nested: {
          name: { form: 'name', required: true },
          kind: { form: 'kind', required: false },
          branch: {
            form: 'branch',
            required: false,
            note: '`branch:true` (RFC-306) lets the script deactivate every edge leaving that port by printing `<port name="x" active="false">reason</port>`; only valid in envelope mode (declared `outputs`).',
          },
        },
      },
      dependencies: { form: 'dependencies:[string]', required: false },
      env: { form: "env:{KEY:'‹secret›'}", required: false },
      readonly: { form: 'readonly:boolean', required: false },
    },
    notes: [
      'Runs `script` inline in the task worktree — no agent, no model. Inbound port values arrive as env vars `AW_PORT_<PORT>` (port name uppercased, chars outside [A-Z0-9_] folded to `_`); they are NEVER substituted into the body, so read them from the environment. Absent/empty `outputs` ⇒ one implicit port `stdout` = raw stdout; non-empty ⇒ the script must print `<workflow-output nonce="$AW_ENVELOPE_NONCE"><port name="…">…</port></workflow-output>`; `path<…>` output kinds are unsupported. `dependencies` must pin exact versions (pip `pkg==1.2.3` / npm `pkg@1.2.3`); bash declares none. `env` VALUES must be `\'‹secret›\'` or `\'\'` — the confirm UI collects real values, literals are rejected (same closed carrier as MCP env). Script nodes cannot sit inside wrapper-fanout, and authoring one requires `scripts:author` — which this session holds.',
    ],
    mistakes: [],
  },
  'code-host-call': {
    availability: {
      kind: 'privileged',
      permission: 'code-host-calls:author',
      redactedFields: CODE_HOST_REDACTED_FIELDS,
      overviewLabel: 'code-host-call (one GitLab/GitHub API call)',
      nestedRedactionHint: `a redacted \`params\` prints as \`{"mr": "${INTENT_REDACTED}"}\` — drop the whole \`params\`, not just the values`,
      untouchableFields: '`provider` / `action` / `allowDestructive` / `timeoutMs`',
    },
    fields: {
      provider: { form: "provider:'gitlab'|'github'", required: true },
      action: { form: "action:'<key from the list below>'", required: true },
      params: { form: "params:{field:'template'}", required: true },
      request: {
        form: 'request:{method,path,query?,body?}',
        required: false,
        nested: {
          method: { form: 'method', required: true },
          path: { form: 'path', required: true },
          query: { form: 'query', required: false },
          body: { form: 'body', required: false },
        },
      },
      allowDestructive: { form: 'allowDestructive', required: false },
      timeoutMs: { form: 'timeoutMs', required: false },
    },
    notes: [
      "The PLATFORM itself issues ONE REST call to GitLab/GitHub with the base URL + token a settings operator configured — no agent, no model, no subprocess, and that token never enters a prompt, a port or your context. Fixed output ports `response` (raw body) and `status` (HTTP status code); the node declares NO input ports, so nothing has to be wired into it. Every `params` VALUE is a template: `{{port_name}}` reads an inbound edge's port, and the canonical webhook trigger references documented in the public workflow section need no edge. Leave `project` empty to act on the task's own repository. A non-2xx response FAILS the node. Authoring one requires `code-host-calls:author` — which this session holds.",
      `\n    \`action:'custom'\` is the escape hatch and its \`request\` is stricter than it looks: \`method\` is one of ${CODE_HOST_METHODS.join(' | ')} (uppercase); \`path\` must start with a single \`/\`, is RELATIVE to the configured base URL (a node can never name a host, so no scheme, no \`//\` prefix), and may contain no \`?\`, no \`#\`, no \`..\` segment and no whitespace — put query parameters in \`query\`, whose values are strings; \`body\` is a STRING holding JSON, not an object, and every \`{{var}}\` in it must sit INSIDE a JSON string value (never as a key, never bare), because the platform escapes each rendered value as a JSON string before re-parsing the whole body. Any \`DELETE\` additionally needs \`allowDestructive:true\`. Actions (\`*\` = required on that provider, \`?\` = optional):`,
    ],
    mistakes: [],
  },
  'code-round': {
    availability: { kind: 'synthesized-only' },
    notes: [
      'The platform synthesizes it for code-capability rounds; a workflow you author containing that kind is rejected at save time.',
    ],
    mistakes: [],
  },
} as const satisfies { readonly [K in NodeKind]: NodeTeachingOf<K> }

export type IntentNodeTeaching = typeof INTENT_NODE_TEACHING
