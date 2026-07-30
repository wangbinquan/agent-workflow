// RFC-234 §4/§1.3 (T5) — INTENT.md composition + deterministic history
// compaction.
//
// INTENT.md is the single entry document the intent agent reads first. It is
// assembled fresh every turn (the underlying opencode store is ephemeral —
// multi-turn = full context replay). Composition rules, all locked by
// tests/rfc234-intent-doc.test.ts:
//
//  - History compaction is DETERMINISTIC (design §1.3): the most recent
//    RECENT_TURNS_VERBATIM turns render verbatim; older turns collapse to one
//    structured line each; ANSWER turns are decision facts and NEVER compact.
//    Any truncation is explicitly labeled — silence never means completeness.
//  - Every user-authored or resource-derived text enters through
//    fenceUntrusted(nonce) (RFC-200): the fence is an injection MITIGATION,
//    not an authorization boundary (that lives in mount approval + apply
//    revalidation).
//  - The document teaches the exact output contract (ports, handle grammar,
//    secret sentinel, size bounds) so schema rejections stay rare.

import { INTENT_LIMITS, fenceUntrusted, type IntentQuestion } from '@agent-workflow/shared'

export const RECENT_TURNS_VERBATIM = 8
const HISTORY_VERBATIM_TURN_CAP_BYTES = 16 * 1024

export interface IntentDocTurn {
  seq: number
  role: 'user' | 'agent'
  kind: 'message' | 'answers' | 'mount-approval' | 'questions' | 'changeset' | 'error'
  /** Display text: message text / summary / structured JSON for answers. */
  text: string
}

export interface IntentDocInput {
  sessionTitle: string
  turns: readonly IntentDocTurn[]
  /** Canonical JSON of the current draft changeset; null when none. */
  currentDraftJson: string | null
  /** Blocking validation errors on the current draft (verbatim strings). */
  validationErrors: readonly string[]
  /** Pending unanswered questions from the latest questions turn, if any. */
  pendingQuestions: readonly IntentQuestion[]
  hiddenDependencyNote: string | null
  envelopeNonce: string
  /** Output language directive (config intentBuilderLang or mirror-input). */
  langDirective: string
}

function clip(text: string, capBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= capBytes) return { text, truncated: false }
  let out = text
  while (Buffer.byteLength(out, 'utf8') > capBytes) {
    out = out.slice(0, Math.floor(out.length * 0.9))
  }
  return { text: out, truncated: true }
}

/** Deterministic history block. Exported separately for the golden test. */
export function renderHistory(turns: readonly IntentDocTurn[], nonce: string): string {
  const lines: string[] = []
  const verbatimFrom = Math.max(0, turns.length - RECENT_TURNS_VERBATIM)
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i] as IntentDocTurn
    const label = `turn ${turn.seq} (${turn.role}/${turn.kind})`
    const isAnswers = turn.kind === 'answers' || turn.kind === 'mount-approval'
    if (i >= verbatimFrom || isAnswers) {
      const { text, truncated } = clip(turn.text, HISTORY_VERBATIM_TURN_CAP_BYTES)
      lines.push(`### ${label}${truncated ? ' [TRUNCATED]' : ''}`)
      lines.push(fenceUntrusted(label, text, nonce))
      lines.push('')
    } else {
      const first = turn.text.split('\n', 1)[0] ?? ''
      const head = first.length > 200 ? `${first.slice(0, 200)}…` : first
      lines.push(`- ${label} [compacted]: ${fenceUntrusted(label, head, nonce)}`)
    }
  }
  if (verbatimFrom > 0) {
    lines.unshift(
      `> History note: turns before ${turns[verbatimFrom]?.seq ?? '?'} are compacted to one line each (answers are never compacted).`,
      '',
    )
  }
  return lines.join('\n')
}

export function buildIntentDoc(input: IntentDocInput): string {
  const sections: string[] = []
  // Codex impl-gate P1-4: the title is user-authored (derived from their first
  // message) — it must be fenced like any other untrusted text, not spliced
  // into the system-authored heading.
  sections.push(`# Intent session

${fenceUntrusted('session title', input.sessionTitle, input.envelopeNonce)}

You are the intent builder for the agent-workflow platform. Working directory
layout:

- \`INTENT.md\` — this document (goal, history, current draft, output contract)
- \`inventory/\` — summaries of every resource you may reference by handle
- \`mounted/\` — full dumps of the resources this session works on

## Platform model (essentials)

Six resource types: agent, skill, mcp, plugin, workflow, workgroup.
- An **agent** is a persona (frontmatter + system prompt body) with typed
  output ports; it may reference skills / mcp / plugins / other agents.
- A **workflow** is a static DAG: agent-single nodes (each runs one agent with
  a prompt template), input/output nodes, wrapper-git / wrapper-loop /
  wrapper-fanout containers, review (human approval) and clarify nodes.
  Wrappers list inner node ids in \`nodeIds\`; nodes stay flat in \`nodes[]\`.
- A **workgroup** is a roster of agent/human members with a mode
  (leader_worker | free_collab | dynamic_workflow) and a charter.
- A **skill** is a directory: SKILL.md (authored via \`bodyMd\`) + auxiliary
  TEXT files.

## Reference rules (hard)

- Reference existing resources ONLY by their session handle
  (\`res#<type>#<n>\`, as listed in inventory/ and mounted/).
- Reference resources you are creating in this changeset by their
  \`$new:<slug>\` tempRef.
- NEVER invent ids, ULIDs, usernames or file paths. Unknown handle = rejection.
- Prefer REUSING existing resources over creating near-duplicates.
- To modify a resource that is NOT under mounted/, use the \`requests\` port to
  ask the user to mount it — mounting requires their approval.

## Secrets (hard)

Credential-bearing fields (MCP env values / remote headers) must be the exact
sentinel \`‹secret›\` — the user fills real values at confirm time. Emitting
anything credential-shaped anywhere in the changeset is rejected.`)

  // Live-run lesson (deepseek 2026-07-28): without an explicit per-type field
  // spec the model invents payload keys (systemPrompt/outputPorts/handle/…),
  // display-style names and nested ops. Payloads are STRICT objects — spell
  // out the exact field lists plus one worked example.
  sections.push(`## Payload schemas (STRICT — unknown keys are rejected)

Common rules:
- \`name\`: machine slug matching ^[a-z0-9][a-z0-9_-]*$ (human wording goes in \`description\`).
- \`opId\`: \`op-1\`, \`op-2\`, … in order. tempRef: \`$new:<slug>\`.
- The changeset port contains ONE flat \`{"$schema_version":1,"ops":[…]}\` — never nest an \`ops\` array inside an op.
- ref = a \`res#<type>#<n>\` handle or a \`$new:<slug>\` tempRef declared in this same changeset.
- Output budget: the WHOLE changeset must fit your model output limit. Keep \`bodyMd\`/\`instructions\` concise (aim ≤120 lines each). If the bundle risks truncation, emit fewer ops this turn and say in \`summary\` what you will add next turn.

Per-type payload fields:
- **agent**: \`{name, description, outputs: string[], bodyMd}\` + optional \`{outputKinds:{port:kind}, outputWrapperPortNames:{agentPort:wrapperPort}, inputs:[{name,kind,required?,description?}], role:'normal'|'aggregator', runtime, skills:[ref|{kind:'project',name}], dependsOn:[ref], mcp:[ref], plugins:[ref], syncOutputsOnIterate, frontmatterExtra}\`. \`bodyMd\` is the agent's full markdown body (its system prompt). There is NO \`systemPrompt\`/\`ports\`/\`outputPorts\` field. Port kinds (\`outputKinds\` values / \`inputs[].kind\`): \`string\` (default) | \`markdown\` | \`signal\` | \`path<ext>\` | \`list<kind>\` — nothing else. \`outputWrapperPortNames\` is only for an aggregator inside wrapper-fanout; omit it when wrapper outlet names equal the agent output names.
- **skill**: \`{name, description, bodyMd}\` + optional \`{files:[{path,content}], frontmatterExtra}\`. \`bodyMd\` becomes SKILL.md. Skills have NO inputs/outputs.
- **mcp**: \`{type:'local', name, description, config:{command: string[], env?:{KEY:'‹secret›'}}}\` OR \`{type:'remote', name, description, config:{url, headers?:{KEY:'‹secret›'}}}\`.
- **plugin**: \`{name, spec, description, optionsJson?, enabled?}\` (spec = npm package or git/file URL; the key is exactly \`optionsJson\`, never \`options\`).
- **workflow**: \`{name, description, definition:{$schema_version:4, inputs:[…], nodes:[…], edges:[…], outputs?}}\`.
  Input declarations all use \`{kind,key,label,required?,description?}\`. Supported kinds and extra fields:
  \`text{multiline?,maxLength?}\`; \`files{minCount?,maxCount?,accept?}\`;
  \`enum{choices,multiSelect?,allowOther?}\`; \`git{gitKind:'branch'|'commit-range'|'pr'}\`;
  \`upload{targetDir,accept?,maxFileSize?,minCount?,maxCount?}\`.
  Every node has \`{id,kind}\` and may carry \`position:{x,y}\` / \`title\`. Supported node forms:
  - \`{id,kind:'input',inputKey}\`.
  - \`{id,kind:'agent-single',agentRef:ref,promptTemplate,overrides?}\`. Use \`agentRef\`, never agentId/agentName.
  - \`{id,kind:'output',ports:[{name,bind:{nodeId,portName}}]}\`. Every incoming edge target port MUST be declared here with the same binding; omitting \`ports\` produces no task output.
  - \`{id,kind:'wrapper-git',nodeIds:[nodeId]}\`. Its only output is \`git_diff:list<path<*>>\`; it accepts no inbound edge itself (outer inputs may target its inner agent nodes).
  - \`{id,kind:'wrapper-loop',nodeIds:[nodeId],maxIterations,exitCondition:{kind:'port-empty'|'port-not-empty'|'port-equals'|'port-count-lt',nodeId,portName,value?,n?,separator?},outputBindings:[{name,bind:{nodeId,portName}}]}\`.
  - \`{id,kind:'wrapper-fanout',nodeIds:[nodeId],inputs:[{name,kind,isShardSource?}],expectedShardCount?}\`. Exactly one input has \`isShardSource:true\` and a \`list<T>\` kind. v1 inner nodes are agent-single only; at most one inner agent may have payload \`role:'aggregator'\`. Worker→aggregator is an ordinary inner edge; the runtime groups every shard's worker output into that aggregator input. Never target the aggregator with a \`boundary:'wrapper-input'\` edge — runtime intentionally does not inject wrapper inputs into aggregators. Aggregator outputs are promoted through \`boundary:'wrapper-output'\` edges to wrapper outlets (same name unless the aggregator payload maps it with \`outputWrapperPortNames\`).
  - \`{id,kind:'review',title?,inputSource:{nodeId,portName},rerunnableOnReject:[nodeId],rerunnableOnIterate:[nodeId],rollbackFilesOnReject?,rollbackFilesOnIterate?}\`. Also add the matching source→review edge targeting \`__review_input__\`; approved single-document output ports are \`approved_doc\` and \`approval_meta\`.
  - \`{id,kind:'clarify',title?,description?,sessionMode?:'isolated'|'inline',clarifyMode?:'optional'}\`.
  - \`{id,kind:'clarify-cross-agent',title?,description?,sessionModeForQuestioner?:'isolated'|'inline'}\`.
  Ordinary edges: \`{id,source:{nodeId,portName},target:{nodeId,portName}}\`. A fanout boundary edge additionally has \`boundary:'wrapper-input'|'wrapper-output'\`: wrapper-input runs from wrapper declared input → inner agent input; wrapper-output runs from inner aggregator output → wrapper outlet. An input node's out-port = its inputKey; an agent's out-ports = its \`outputs\`; prompt templates read inbound ports as \`{{port_name}}\`.
- **workgroup**: \`{name, description, instructions, mode:'leader_worker'|'free_collab'|'dynamic_workflow', leaderDisplayName?, members:[{memberType:'agent', agentRef: ref, displayName, roleDesc} | {memberType:'human', displayName, roleDesc}], switches?:{shareOutputs:boolean,directMessages:boolean,blackboard:boolean}, maxRounds?:integer(1..1000), completionGate?:boolean, clarifyBudget?:integer(0..50), fanOut?:boolean}\`. Human members are placeholders — never real usernames. Visibility choices must be encoded structurally: for “private direct messages + public blackboard”, set \`switches:{shareOutputs:true,directMessages:true,blackboard:true}\`; prose in \`instructions\` does not change runtime switches.

Worked example (one agent):
\`{"$schema_version":1,"ops":[{"opId":"op-1","action":"create","resourceType":"agent","tempRef":"$new:code-auditor","payload":{"name":"code-auditor","description":"代码审计代理：逐文件审查 git diff","outputs":["findings"],"bodyMd":"# 角色\\n你审查 git diff…"}}]}\`

JSON closure check (especially when the final op is a workflow): after the last edge,
close the edges array, then close definition, payload, and the final op, then close
the ops array and root object. The final structural suffix is \`]}}}]}\`, not
\`]}}]}\`. Do not rely on prose self-checks; emit the actual delimiters.`)

  sections.push(`## Output contract

End your reply with ONE envelope (last one wins). Ports:
- \`summary\` (required, ≤2 KiB): what you did or why you are asking.
- EXACTLY ONE of:
  - \`changeset\`: JSON \`{"$schema_version":1,"ops":[...]}\` — ops are
    \`{opId, action:'create', resourceType, tempRef, payload}\` or
    \`{opId, action:'update', resourceType, target:'res#…', payload}\`.
    Updates carry the COMPLETE new document, not a diff. Limits: ≤${INTENT_LIMITS.maxOps} ops,
    canonical JSON ≤${INTENT_LIMITS.maxChangesetBytes} bytes, skill files ≤${INTENT_LIMITS.maxSkillFiles} × ${INTENT_LIMITS.maxSkillFileBytes} bytes.
  - \`questions\`: JSON array of ≤${INTENT_LIMITS.maxQuestions} \`{id, question, options[2..4], multiSelect}\`
    — use when the intent is ambiguous; the user answers before you generate.
- \`requests\` (optional): JSON array of ≤${INTENT_LIMITS.maxMountRequests}
  \`{resourceType, name, reason?}\` mount SUGGESTIONS (user must approve).

${input.langDirective}`)

  sections.push(`## Conversation history\n\n${renderHistory(input.turns, input.envelopeNonce)}`)

  if (input.pendingQuestions.length > 0) {
    sections.push(
      `## Pending questions you asked (now answered above — regenerate accordingly)\n\n${fenceUntrusted(
        'pending questions',
        JSON.stringify(input.pendingQuestions, null, 2),
        input.envelopeNonce,
      )}`,
    )
  }

  if (input.currentDraftJson !== null) {
    sections.push(
      `## Current draft changeset (your previous proposal — evolve it, do not restart unless asked)\n\n${fenceUntrusted(
        'current draft',
        input.currentDraftJson,
        input.envelopeNonce,
      )}`,
    )
  }

  if (input.validationErrors.length > 0) {
    sections.push(
      `## BLOCKING validation errors on the current draft (fix ALL of these)\n\n${input.validationErrors
        .map((e) => `- ${fenceUntrusted('validation error', e, input.envelopeNonce)}`)
        .join('\n')}`,
    )
  }

  if (input.hiddenDependencyNote !== null) {
    sections.push(`## Access notes\n\n${input.hiddenDependencyNote}`)
  }

  return `${sections.join('\n\n')}\n`
}
