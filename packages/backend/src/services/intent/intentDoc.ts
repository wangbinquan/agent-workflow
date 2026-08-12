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

import {
  CODE_HOST_METHODS,
  CODE_HOST_PROVIDERS,
  CODE_HOST_REDACTED_FIELDS,
  INTENT_LIMITS,
  INTENT_REDACTED,
  SCRIPT_REDACTED_FIELDS,
  TRIGGER_CONTEXT_VARS,
  codeHostActionDef,
  codeHostActionFields,
  codeHostActionSupported,
  codeHostActionsByGroup,
  codeHostRequiredFields,
  fenceUntrusted,
  isUnsupportedBinding,
  type IntentQuestion,
  type PrivilegedNodeLens,
} from '@agent-workflow/shared'

export const RECENT_TURNS_VERBATIM = 8
const HISTORY_VERBATIM_TURN_CAP_BYTES = 16 * 1024
export const INTENT_TURN_GUIDANCE = Object.freeze({
  maxOps: 8,
  maxWorkflowNodesCreatedOrReplaced: 6,
  targetChangesetBytes: 256 * 1024,
})

export interface IntentDocTurn {
  seq: number
  role: 'user' | 'agent'
  kind: 'message' | 'answers' | 'mount-approval' | 'questions' | 'changeset' | 'error'
  /** Display text: message text / summary / structured JSON for answers. */
  text: string
}

/**
 * RFC-253 / RFC-269 — 会话发起者手上有没有两个特权节点的创作权。
 *
 * 这不是排版偏好，是**别让用户白跑一轮**：两类节点的落库门在持久化原语上
 * （`scriptAuthorGate` / `codeHostAuthorGate`），一个 `role:'user'` 的发起者拿不
 * 到 `scripts:author` / `code-host-calls:author`，模型就算把节点写得完全正确，
 * 整包 changeset 也在 apply 时 403 —— 而一轮 intent 是一次真实的模型进程。所以
 * 无权限时形态根本不进 doc，另换一条明确的禁令，让模型改为跟用户解释。
 *
 * 取值由 `privilegedNodeLensFor(actor)` 取反而来（turnEngine），与两个写门读的是
 * 同一个 `actor.permissions`，因此不可能漂移出「doc 教了但存不下」的组合。
 */
export interface IntentDocPrivileges {
  mayAuthorScripts: boolean
  mayAuthorCodeHostCalls: boolean
}

/**
 * The lens says "redact this" (`true` = the actor may NOT author); the doc wants
 * the positive capability. Flip it in exactly one place so the two spellings can
 * never drift apart.
 */
export function privilegesFromLens(lens: PrivilegedNodeLens): IntentDocPrivileges {
  return { mayAuthorScripts: !lens.scripts, mayAuthorCodeHostCalls: !lens.codeHost }
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
  /**
   * RFC-291 面 C — mounted roots that could not be materialised this epoch.
   *
   * Kept SEPARATE from hiddenDependencyNote on purpose: one says "a dependency
   * of something you can see is invisible to you", the other says "a resource
   * you explicitly mounted is gone". Folding them into one parameter would make
   * the rendered advice wrong for whichever case lost the coin toss.
   */
  unavailableMountNote: string | null
  envelopeNonce: string
  /** Output language directive (config intentBuilderLang or mirror-input). */
  langDirective: string
  privileges: IntentDocPrivileges
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

/**
 * RFC-269 的动作目录，**从注册表派生**而不是手抄一份进 prompt。
 *
 * 手抄的那天注册表一改 doc 就静默过期，模型继续按旧清单生成——这正是
 * `code-host-call` 整类节点最初在 doc 里全缺席的同一类漂移（RFC-253 补 script
 * 形态时立过先例，RFC-269 / RFC-243 落地时没跟上）。派生还顺带保证「必填字段」
 * 与校验器读的是同一个 `codeHostRequiredFields`，模型照着 doc 填就撞不上
 * `code-host-param-missing`；`select` 字段直接把合法取值摊开，避免
 * `code-host-param-invalid`。
 *
 * `*` = 该 provider 必填，`?` = 可选。unsupported 如实写出来而不是隐去该动作：
 * 模型需要知道「这件事在 GitHub 上做不到」才能改口跟用户解释，而不是换个动作瞎试。
 */
function renderCodeHostActionCatalog(): string {
  const lines: string[] = []
  for (const { group, actions } of codeHostActionsByGroup()) {
    for (const action of actions) {
      const perProvider = CODE_HOST_PROVIDERS.map((provider) => {
        if (!codeHostActionSupported(action, provider)) {
          const binding = codeHostActionDef(action).bindings[provider]
          const reason = isUnsupportedBinding(binding) ? binding.reasonKey : 'unsupported'
          return `${provider}: UNSUPPORTED (${reason})`
        }
        const required = new Set<string>(codeHostRequiredFields(action, provider))
        const fields = codeHostActionFields(action, provider).map((field) => {
          const options =
            field.control === 'select' && field.options !== undefined
              ? `(${field.options.join('|')})`
              : ''
          return `${field.name}${required.has(field.name) ? '*' : '?'}${options}`
        })
        return `${provider}: ${fields.length === 0 ? '(no fields)' : fields.join(', ')}`
      })
      lines.push(`    - \`${action}\` [${group}] — ${perProvider.join(' · ')}`)
    }
  }
  return lines.join('\n')
}

export function buildIntentDoc(input: IntentDocInput): string {
  const sections: string[] = []
  const { mayAuthorScripts, mayAuthorCodeHostCalls } = input.privileges
  // The overview must not advertise a kind whose FORM the doc then withholds:
  // a model told "script nodes exist" but shown no field list invents one.
  const privilegedOverview = [
    mayAuthorScripts ? 'script (inline code, no model)' : null,
    mayAuthorCodeHostCalls ? 'code-host-call (one GitLab/GitHub API call)' : null,
  ].filter((entry) => entry !== null)
  const privilegedNodeForms = [
    mayAuthorScripts
      ? `  - \`{id,kind:'script',language:'python'|'bash'|'node',script,outputs?:[{name,kind?}],dependencies?:[string],env?:{KEY:'‹secret›'},readonly?:boolean}\`. Runs \`script\` inline in the task worktree — no agent, no model. Inbound port values arrive as env vars \`AW_PORT_<PORT>\` (port name uppercased, chars outside [A-Z0-9_] folded to \`_\`); they are NEVER substituted into the body, so read them from the environment. Absent/empty \`outputs\` ⇒ one implicit port \`stdout\` = raw stdout; non-empty ⇒ the script must print \`<workflow-output nonce="$AW_ENVELOPE_NONCE"><port name="…">…</port></workflow-output>\`; \`path<…>\` output kinds are unsupported. \`dependencies\` must pin exact versions (pip \`pkg==1.2.3\` / npm \`pkg@1.2.3\`); bash declares none. \`env\` VALUES must be \`'‹secret›'\` or \`''\` — the confirm UI collects real values, literals are rejected (same closed carrier as MCP env). Script nodes cannot sit inside wrapper-fanout, and authoring one requires \`scripts:author\` (admin/manager) — which this session holds.`
      : null,
    mayAuthorCodeHostCalls
      ? `  - \`{id,kind:'code-host-call',provider:'gitlab'|'github',action:'<key from the list below>',params:{field:'template'},request?,allowDestructive?,timeoutMs?}\`. The PLATFORM itself issues ONE REST call to GitLab/GitHub with the base URL + token an administrator configured in settings — no agent, no model, no subprocess, and that token never enters a prompt, a port or your context. Fixed output ports \`response\` (raw body) and \`status\` (HTTP status code); the node declares NO input ports, so nothing has to be wired into it. Every \`params\` VALUE is a template: \`{{port_name}}\` reads an inbound edge's port, and \`{{trigger.<var>}}\` reads the webhook event that started the task (that one needs no edge at all). \`trigger\` accepts ONLY these ${TRIGGER_CONTEXT_VARS.length} names — anything else is refused at launch with \`code-host-var-unknown\`: ${TRIGGER_CONTEXT_VARS.join(', ')}. Leave \`project\` empty to act on the task's own repository. A non-2xx response FAILS the node. Authoring one requires \`code-host-calls:author\` (admin/manager) — which this session holds.
    \`action:'custom'\` is the escape hatch and its \`request\` is stricter than it looks: \`method\` is one of ${CODE_HOST_METHODS.join(' | ')} (uppercase); \`path\` must start with a single \`/\`, is RELATIVE to the configured base URL (a node can never name a host, so no scheme, no \`//\` prefix), and may contain no \`?\`, no \`#\`, no \`..\` segment and no whitespace — put query parameters in \`query\`, whose values are strings; \`body\` is a STRING holding JSON, not an object, and every \`{{var}}\` in it must sit INSIDE a JSON string value (never as a key, never bare), because the platform escapes each rendered value as a JSON string before re-parsing the whole body. Any \`DELETE\` additionally needs \`allowDestructive:true\`. Actions (\`*\` = required on that provider, \`?\` = optional):
${renderCodeHostActionCatalog()}`
      : null,
  ].filter((entry) => entry !== null)
  // A withheld kind must be stated, not silently absent: the user CAN ask for
  // one, and "I was not taught that form" would read as the platform lacking
  // the feature. Naming the permission is what lets them go get it.
  // Codex round-2 P2 — the omission list is PER WITHHELD KIND, never the union.
  //
  // Rehydration keys off the lens (what the actor may NOT author); the dump's
  // masking does not — `maskWorkflowScriptEnv` redacts script `env` for
  // everyone, permissions or no (RFC-253 T28: env is a closed carrier). For an
  // actor who may author scripts but not code-host calls the two diverge: they
  // still SEE `env: {…: '‹redacted›'}` but nothing would restore it, so telling
  // them to omit it deletes a stored credential through a save the gate
  // correctly allows — silent data loss with no error. Each entry therefore
  // carries its own field list, and only withheld kinds contribute one.
  const withheldNodeKinds = [
    mayAuthorScripts
      ? null
      : {
          kind: 'script',
          point: 'scripts:author',
          fields: SCRIPT_REDACTED_FIELDS as readonly string[],
          // The nested example has to be scoped too, not just the field list.
          // Codex round-3 P2: the round-2 fix trimmed the list and left an
          // unconditional "drop the whole `env`" behind, which reproduced the
          // very deletion the scoping exists to prevent — a script AUTHOR sees
          // a redacted `env` (masking is permission-blind) and gets no
          // rehydration, so omitting it deletes the stored credential.
          nested: `a redacted \`env\` prints as \`{"NAME": "${INTENT_REDACTED}"}\` — drop the whole \`env\`, not just the value`,
        },
    mayAuthorCodeHostCalls
      ? null
      : {
          kind: 'code-host-call',
          point: 'code-host-calls:author',
          fields: CODE_HOST_REDACTED_FIELDS as readonly string[],
          nested: `a redacted \`params\` prints as \`{"mr": "${INTENT_REDACTED}"}\` — drop the whole \`params\`, not just the values`,
        },
  ].filter((entry) => entry !== null)
  // Same reasoning for the see-but-do-not-touch list: naming another kind's
  // fields here would tell an authorized author their own edits are forbidden.
  const untouchableFields = [
    mayAuthorScripts ? null : '`language` / `readonly` / `outputs`',
    mayAuthorCodeHostCalls ? null : '`provider` / `action` / `allowDestructive` / `timeoutMs`',
  ]
    .filter((entry) => entry !== null)
    .join(' / ')
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
  wrapper-fanout containers, review (human approval) and clarify nodes, plus
  call-workflow / call-workgroup, which delegate a stage to an independent child
  task${privilegedOverview.length === 0 ? '' : `, and ${privilegedOverview.join(' / ')}`}.
  Wrappers list inner node ids in \`nodeIds\`; nodes stay flat in \`nodes[]\`.
  "Supported node forms" under Payload schemas is EXHAUSTIVE — a kind absent
  from it does not exist for you, whatever the platform may support elsewhere.
- A **workgroup** is a roster of agent/human members with a mode
  (leader_worker | free_collab | dynamic_workflow) and a charter.
- A **skill** is a directory: SKILL.md (authored via \`bodyMd\`) + auxiliary
  TEXT files.

## Reference rules (hard)

- Reference existing resources ONLY by their session handle
  (\`res#<type>#<n>\`, as listed in inventory/ and mounted/).
- EXACTLY ONE exception, inside a workflow definition: \`call-workflow\` /
  \`call-workgroup\` nodes select their target by its exact NAME — the backticked
  name printed next to the handle in inventory/ — because the name is the field
  the platform persists and exports to YAML. Copy it character for character; a
  handle in \`workflowName\` / \`workgroupName\` is wrong. Two consequences follow
  from the name being resolved LATE (at launch, not at save), and you must
  respect both:
  - **A name is not a stable reference.** Renaming a target later breaks every
    caller (\`call-workflow-ref-missing\`). If the user renames something that
    other workflows call, say that those callers need updating too.
  - **Names are not unique.** If more than one resource in inventory/ carries
    the target's name, launch binds the OLDEST one the launching user can see —
    possibly not the one meant. Ask the user which one instead of guessing.
- Reference resources you are creating in this changeset by their
  \`$new:<slug>\` tempRef.
- NEVER invent ids, ULIDs, usernames or file paths. Unknown handle = rejection.
- Prefer REUSING existing resources over creating near-duplicates.
- To modify a resource that is NOT under mounted/, use the \`requests\` port to
  ask the user to mount it — mounting requires their approval.

## Secrets (hard)

Credential-bearing fields (MCP env values / remote headers) must be the exact
sentinel \`‹secret›\` — the user fills real values at confirm time. Emitting
anything credential-shaped anywhere in the changeset is rejected.${
    withheldNodeKinds.length === 0
      ? ''
      : `

## Capability limits (hard)

The user who started this session does NOT hold the permission these node kinds
require:
${withheldNodeKinds
  .map((entry) => `- \`kind:'${entry.kind}'\` requires \`${entry.point}\` (admin / manager).`)
  .join('\n')}

So you must not CREATE one and must not CHANGE one — **and must not DELETE one
either**. That third rule is the one that bites, because an \`update\` payload
carries the COMPLETE definition:

- **Creating / changing**: do not emit a new node of these kinds, and do not
  alter any field of an existing one. If the user asks for one, tell them
  plainly that their account lacks the permission — do not silently substitute
  another kind — and offer what you CAN build instead (typically an agent whose
  prompt does the same work).
- **Preserving**: a workflow under \`mounted/\` MAY ALREADY CONTAIN one. Its
  privileged fields are printed as \`${INTENT_REDACTED}\` precisely because you may not read
  them. When you update that workflow, copy the node back with the same \`id\`,
  the same \`kind\`, the same place in \`nodes[]\` and its edges untouched — but
  **OMIT these WHOLE FIELDS instead of echoing the marker** — ${withheldNodeKinds
    .map((entry) => `\`${entry.fields.join('` / `')}\` on a ${entry.kind} node`)
    .join(', ')}. Leave the field out of the node object entirely; do not send it
  emptied, and do not send the inner keys either (${withheldNodeKinds
    .map((entry) => entry.nested)
    .join('; ')}). Any string
  containing \`${INTENT_REDACTED}\` is rejected as a corrupted credential before the permission
  check is even reached, so echoing the marker fails the changeset; omitting the
  field is what tells the platform to restore the stored value. This applies ONLY
  to the kinds listed above — a redacted field on a node kind you MAY author is
  not restored for you, so omitting it there would delete it. Dropping a whole
  node of a listed kind — or editing any field you CAN see on one
  (${untouchableFields}) — counts as CHANGING it.

Apply is all-or-nothing: any of these is refused with
\`script-author-forbidden\` / \`code-host-author-forbidden\` and takes the whole
changeset down with it — including the unrelated edit the user actually asked
for.`
  }`)

  sections.push(`## Single-turn delivery budget (hard guidance, not parser limits)

- Emit at most ${INTENT_TURN_GUIDANCE.maxOps} changeset ops in one turn.
- Across workflow create/update payloads, create or fully replace at most ${INTENT_TURN_GUIDANCE.maxWorkflowNodesCreatedOrReplaced} workflow nodes in one turn.
- Target at most ${INTENT_TURN_GUIDANCE.targetChangesetBytes / 1024} KiB of changeset JSON.
- If the user's final goal is larger, deliver one complete, verifiable slice now (dependencies first or one workflow slice), then list the remaining work in \`summary\` for the next turn.
- Every slice MUST end with a complete nonce-bound envelope. Never omit the current turn's result merely to keep thinking.

The server still accepts the larger formal limits printed below; these numbers guide reliable batching and do not shrink that accepted domain.`)

  // Live-run lesson (deepseek 2026-07-28): without an explicit per-type field
  // spec the model invents payload keys (systemPrompt/outputPorts/handle/…),
  // display-style names and nested ops. Payloads are STRICT objects — spell
  // out the exact field lists plus one worked example.
  sections.push(`## Payload schemas (STRICT — unknown keys are rejected)

Common rules:
- \`name\` for **agent / skill / mcp / plugin**: machine slug matching ^[a-z0-9][a-z0-9_-]*$ (human wording goes in \`description\`). These names become an OpenCode agent key, an on-disk skill directory and an MCP server key, so they stay ASCII.
- \`name\` for **workflow / workgroup**: an ordinary human-readable name in the USER'S OWN LANGUAGE — Chinese is expected when the user writes Chinese (\`代码审计流水线\`). Must not start with \`_\`, must not contain control characters or line breaks, at most 128 characters.
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
  \`upload{targetDir,accept?,maxFileSize?,minCount?,maxCount?,onConflict?}\`
  (\`onConflict:'rename'|'overwrite'\`, default \`rename\`: on a name clash inside \`targetDir\`,
  \`rename\` writes \`report (1).pdf\` and keeps the existing file, \`overwrite\` replaces it and keeps
  the original path. Two uploaded files landing on the same path are rejected at launch either way).
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
  - \`{id,kind:'call-workflow',workflowName:'<exact target name>',limits?:{maxDurationMs?,maxTotalTokens?}}\`. Runs ANOTHER workflow as an independent child task. Its ports MIRROR that child's declared inputs (in-ports) and outputs (out-ports), so you can only wire it correctly where you can actually read them: a workflow under \`mounted/\`, or one you create in this same changeset. For a workflow you only see summarized in inventory/, ask the user to mount it instead of guessing port names. Two launch-time rules the definition alone will not tell you: EVERY one of the child's declared inputs needs its own ordinary incoming edge targeting that exact input key — including inputs the child marks optional, else \`call-workflow-input-unwired\`; and a child that declares any \`upload\` input CANNOT be called at all (\`call-workflow-upload-input-unsupported\`), so pick a different composition rather than emitting a caller that can never launch.
  - \`{id,kind:'call-workgroup',workgroupName:'<exact target name>',goalTemplate,limits?:{maxDurationMs?,maxTotalTokens?}}\`. Hands this stage to a workgroup running as an independent child task. Inbound ports are edge-derived (each incoming edge's target portName IS the variable name) and readable inside \`goalTemplate\` as \`{{port_name}}\`; the single output port is \`result\`.${
    privilegedNodeForms.length === 0 ? '' : `\n${privilegedNodeForms.join('\n')}`
  }
  Ordinary edges: \`{id,source:{nodeId,portName},target:{nodeId,portName}}\`. A fanout boundary edge additionally has \`boundary:'wrapper-input'|'wrapper-output'\`: wrapper-input runs from wrapper declared input → inner agent input; wrapper-output runs from inner aggregator output → wrapper outlet. An input node's out-port = its inputKey; an agent's out-ports = its \`outputs\`; prompt templates read inbound ports as \`{{port_name}}\`.
- **workgroup**: \`{name, description, instructions, mode:'leader_worker'|'free_collab'|'dynamic_workflow', outputContract?:'files'|'discussion', leaderDisplayName?, members:[{memberType:'agent', agentRef: ref, displayName, roleDesc} | {memberType:'human', displayName, roleDesc}], switches?:{shareOutputs:boolean,directMessages:boolean,blackboard:boolean}, maxRounds?:integer(1..1000), completionGate?:boolean, clarifyBudget?:integer(0..50), fanOut?:boolean}\`. Use \`discussion\` when the primary result is a room conclusion and files are optional; omitted means \`files\`. Human members are placeholders — never real usernames. Visibility choices must be encoded structurally: for “private direct messages + public blackboard”, set \`switches:{shareOutputs:true,directMessages:true,blackboard:true}\`; prose in \`instructions\` does not change runtime switches.

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

  const accessNotes = [input.hiddenDependencyNote, input.unavailableMountNote].filter(
    (note): note is string => note !== null,
  )
  if (accessNotes.length > 0) {
    sections.push(`## Access notes\n\n${accessNotes.join('\n\n')}`)
  }

  return `${sections.join('\n\n')}\n`
}
