// RFC-148 T1 — prompt golden 矩阵（先钉后收）。
//
// 为什么这条测试存在：RFC-148 要删除 shared/prompt.ts 里 RFC-132 挂账的三代
// 叠置死注入路径（crossClarifyContext 全族 / legacy 轮次分组臂 / 5 死函数链），
// 并把 followup 四散装字段与 clarify 四散装布尔收敛为判别联合。本文件在动刀
// **之前**把全部活组合的渲染输出逐字节锁死——T2 删除与 T3 重构的交付判据就是
// 本矩阵零改动全绿（活路径字节零变化的机器证明）。
//
// 行说明（活语义格）：
//   - flat-inline 与 prior-output-inline-suppressed 期望字节完全相同——inline
//     模式抑制 prior-output 重注（prompt.ts priorOutputSection 门）正是该等式。
//   - inline-no-channel 锁 STOP 轮边界：inline 且无 clarify 通道时 trailing 回落
//     完整 output 协议（prompt.ts 注释警告的边界）。
//   - fu-envelope-missing-nochan ≠ fu-envelope-missing-chan：hasClarifyChannel
//     收窄 reason 并改变 opening/bullets。
//
// 期望值由生成脚本对当前实现求值后内嵌（仓库无 snapshot 惯例，D3）。若你有意
// 改变 prompt 字节（新增段落/措辞调整），请整行重新生成并在 commit message 里
// 说明字节变化的产品意图。

import { renderEnvelopeFollowupPrompt, renderUserPrompt } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'

const BASE = {
  promptTemplate:
    'Do the work on {{spec}}. Repo at {{__repo_path__}}. Iter {{__clarify_iteration__}} rem {{__clarify_remaining__}}.',
  inputs: { spec: 'SPEC-CONTENT' },
  meta: { repoPath: '/repo', baseBranch: 'main', taskId: 't1', nodeId: 'n1' },
  agentOutputs: ['out'],
  agentOutputKinds: { out: 'markdown' },
}
const FLAT = {
  flatBlock: '## Clarify Q&A\n\n1. [q1] Question one?\n   Answer: A1',
  iteration: '2',
  remaining: '1',
}
const RENDER_ROWS: Record<string, Record<string, unknown>> = {
  bare: { ...BASE },
  'clarify-channel': { ...BASE, hasClarifyChannel: true },
  'flat-isolated': { ...BASE, hasClarifyChannel: true, clarifyContext: { ...FLAT } },
  'flat-inline': {
    ...BASE,
    hasClarifyChannel: true,
    clarifyContext: { ...FLAT, mode: 'inline', currentRoundOnly: true },
  },
  'inline-no-channel': {
    ...BASE,
    hasClarifyChannel: false,
    clarifyContext: { ...FLAT, mode: 'inline', currentRoundOnly: true },
  },
  'stop-notice': { ...BASE, hasClarifyChannel: false, clarifyStopNotice: true },
  'prior-output-askback': {
    ...BASE,
    hasClarifyChannel: true,
    priorOutputUpdate: { block: '### PRIOR\nold-output' },
  },
  'prior-output-update': {
    ...BASE,
    hasClarifyChannel: false,
    priorOutputUpdate: { block: '### PRIOR\nold-output' },
  },
  'prior-output-inline-suppressed': {
    ...BASE,
    hasClarifyChannel: true,
    clarifyContext: { ...FLAT, mode: 'inline', currentRoundOnly: true },
    priorOutputUpdate: { block: '### PRIOR\nold-output' },
  },
  'review-reject': {
    ...BASE,
    reviewContext: { rejection: 'needs work', comments: '- fix section 2' },
  },
  'review-iterate-siblings': {
    ...BASE,
    reviewContext: {
      iterateTargetPort: 'out',
      siblingOutputs: 'Keep these consistent:\n### other\nother-content',
    },
  },
}
const FU_ROWS: Record<string, Record<string, unknown>> = {
  'envelope-missing-nochan': { reason: 'envelope-missing', hasClarifyChannel: false },
  'envelope-missing-chan': { reason: 'envelope-missing', hasClarifyChannel: true },
  'both-present': { reason: 'both-present', hasClarifyChannel: true },
  'clarify-malformed': { reason: 'clarify-malformed', hasClarifyChannel: true },
  'clarify-required': { reason: 'clarify-required', hasClarifyChannel: true },
  'envelope-port-malformed': { reason: 'envelope-port-malformed', hasClarifyChannel: false },
  'port-validation': {
    reason: 'port-validation',
    hasClarifyChannel: false,
    portValidations: [
      { port: 'out', kind: 'path<md>', subReason: 'not-found', detail: 'no file at path' },
    ],
    perKindRepairBlocks: ['REPAIR-BLOCK'],
  },
  'clarify-malformed-continue': {
    reason: 'clarify-malformed',
    hasClarifyChannel: true,
    clarifyDirective: 'continue',
  },
}

const EXPECTED_RENDER: Record<string, string> = {
  bare: 'Do the work on SPEC-CONTENT. Repo at /repo. Iter  rem .\n\n---\nYou MUST end your reply with a `<workflow-output>` block listing these ports:\n  - out\n\nFormat:\n<workflow-output>\n  <port name="out">...</port>\n</workflow-output>',
  'clarify-channel':
    'Do the work on SPEC-CONTENT. Repo at /repo. Iter  rem .\n\n---\n**This node is in MANDATORY ASK-BACK (clarify) mode.** The user wired a clarify channel because they require you to interrogate intent BEFORE doing any work. Your ONLY valid reply this round is a `<workflow-clarify>` envelope (format below). You may NOT emit `<workflow-output>` — the framework will reject it and re-prompt you. You are released to produce final output only after the user clicks "Stop clarifying".\n\nOperate with ZERO guessing. Treat every unstated detail as a blocker you resolve by asking, never by assuming.\n- **Investigate first, then ask.** Read the inputs, the repository, referenced files, and every prior-round answer; use any skills and tools available to resolve what you can on your own — never spend a question on something you could determine yourself.\n- **Ask the consequential things, in priority order.** Lead with the decisions that most change the outcome (naming, data shapes, API / contracts, UX behavior, scope boundaries, acceptance criteria, risky edge cases). Batch closely-related points into one question. Do NOT pad with low-stakes "just confirming…" questions — depth over breadth.\n- **Pin down every detail that actually matters before acting.** Do not begin the deliverable until each decision needed to do it correctly is settled by the human. "Mostly clear" is not clear enough.\n- **Never guess unfamiliar terms.** Any proprietary term, acronym, internal system / file / convention you do not fully understand — you MUST ask what it means; never infer or invent a meaning.\n- **No assumptions, no fabrication, no silent defaults.** The moment you catch yourself hedging, writing "TBD", inventing a constraint the inputs didn\'t state, or choosing between plausible alternatives without a stated preference — stop and turn it into a question instead.\n- **Ask in the same language as the inputs / the user.**\n- **Asking back is the correct outcome here, not a failure.** Returning early because you "have enough to start" defeats the purpose of this node.\n\n---\n**Clarify format.** Emit exactly one <workflow-clarify> block and nothing else — no <workflow-output> anywhere in the reply. Asking back is the expected outcome of this round.\n\nFormat:\n<workflow-clarify>\n{\n  "questions": [\n    {\n      "id": "<stable-id>",\n      "title": "<question text>",\n      "kind": "single" | "multi",\n      "options": [\n        {\n          "label": "<picker text>",\n          "description": "<what this option does / expected outcome / trade-offs>",\n          "recommended": true | false,\n          "recommendationReason": "<why the user should pick this one>"\n        }\n      ]\n    }\n  ]\n}\n</workflow-clarify>\n\nHard rules — violation is treated as a malformed reply and the node will fail / retry:\n- Your reply MUST contain exactly one <workflow-clarify> block and NO <workflow-output> — emitting <workflow-output> is rejected until the user stops clarifying. Defer all output ports to a later round; do not output partial data.\n- Limits: at most 5 questions, each question 2–4 options — any option beyond the 4th is silently dropped, so cap each question at 4. Do NOT add a "free text / other" option — the framework appends a user-input row automatically.\n- Each option needs a non-empty "label". The other three fields are optional but strongly recommended: "description" (always render an explanation of what picking this option means), and — when "recommended" is true — "recommendationReason" (why this is your pick).\n- Mark at most a couple of options across the whole envelope as "recommended": true. Recommended options sort to the top of the picker for the user.\n- Legacy form is also accepted: `"options": ["a", "b", "c"]` — strings are lifted into `{label, description:"", recommended:false, recommendationReason:""}`. Prefer the structured form for new emissions.\n- Once the user submits answers, you will receive every question answered so far in the next prompt under "## Clarify Q&A" — a single flat list where each question is an equal peer with the user\'s answer (a deterministic synthesis line). Treat every listed answer as an already-resolved decision.',
  'flat-isolated':
    'Do the work on SPEC-CONTENT. Repo at /repo. Iter 2 rem 1.\n\n## Clarify Q&A\n\n1. [q1] Question one?\n   Answer: A1\n\n---\n**This node is in MANDATORY ASK-BACK (clarify) mode.** The user wired a clarify channel because they require you to interrogate intent BEFORE doing any work. Your ONLY valid reply this round is a `<workflow-clarify>` envelope (format below). You may NOT emit `<workflow-output>` — the framework will reject it and re-prompt you. You are released to produce final output only after the user clicks "Stop clarifying".\n\nOperate with ZERO guessing. Treat every unstated detail as a blocker you resolve by asking, never by assuming.\n- **Investigate first, then ask.** Read the inputs, the repository, referenced files, and every prior-round answer; use any skills and tools available to resolve what you can on your own — never spend a question on something you could determine yourself.\n- **Ask the consequential things, in priority order.** Lead with the decisions that most change the outcome (naming, data shapes, API / contracts, UX behavior, scope boundaries, acceptance criteria, risky edge cases). Batch closely-related points into one question. Do NOT pad with low-stakes "just confirming…" questions — depth over breadth.\n- **Pin down every detail that actually matters before acting.** Do not begin the deliverable until each decision needed to do it correctly is settled by the human. "Mostly clear" is not clear enough.\n- **Never guess unfamiliar terms.** Any proprietary term, acronym, internal system / file / convention you do not fully understand — you MUST ask what it means; never infer or invent a meaning.\n- **No assumptions, no fabrication, no silent defaults.** The moment you catch yourself hedging, writing "TBD", inventing a constraint the inputs didn\'t state, or choosing between plausible alternatives without a stated preference — stop and turn it into a question instead.\n- **Ask in the same language as the inputs / the user.**\n- **Asking back is the correct outcome here, not a failure.** Returning early because you "have enough to start" defeats the purpose of this node.\n\n---\n**Clarify format.** Emit exactly one <workflow-clarify> block and nothing else — no <workflow-output> anywhere in the reply. Asking back is the expected outcome of this round.\n\nFormat:\n<workflow-clarify>\n{\n  "questions": [\n    {\n      "id": "<stable-id>",\n      "title": "<question text>",\n      "kind": "single" | "multi",\n      "options": [\n        {\n          "label": "<picker text>",\n          "description": "<what this option does / expected outcome / trade-offs>",\n          "recommended": true | false,\n          "recommendationReason": "<why the user should pick this one>"\n        }\n      ]\n    }\n  ]\n}\n</workflow-clarify>\n\nHard rules — violation is treated as a malformed reply and the node will fail / retry:\n- Your reply MUST contain exactly one <workflow-clarify> block and NO <workflow-output> — emitting <workflow-output> is rejected until the user stops clarifying. Defer all output ports to a later round; do not output partial data.\n- Limits: at most 5 questions, each question 2–4 options — any option beyond the 4th is silently dropped, so cap each question at 4. Do NOT add a "free text / other" option — the framework appends a user-input row automatically.\n- Each option needs a non-empty "label". The other three fields are optional but strongly recommended: "description" (always render an explanation of what picking this option means), and — when "recommended" is true — "recommendationReason" (why this is your pick).\n- Mark at most a couple of options across the whole envelope as "recommended": true. Recommended options sort to the top of the picker for the user.\n- Legacy form is also accepted: `"options": ["a", "b", "c"]` — strings are lifted into `{label, description:"", recommended:false, recommendationReason:""}`. Prefer the structured form for new emissions.\n- Once the user submits answers, you will receive every question answered so far in the next prompt under "## Clarify Q&A" — a single flat list where each question is an equal peer with the user\'s answer (a deterministic synthesis line). Treat every listed answer as an already-resolved decision.',
  'flat-inline':
    'Do the work on . Repo at /repo. Iter 2 rem 1.\n\n## Clarify Q&A\n\n1. [q1] Question one?\n   Answer: A1\n\n---\nThe user has answered your previous `<workflow-clarify>` round (see "Clarify Q&A — User Answers (Current Round)" above). This node stays in MANDATORY ask-back mode until the user clicks "Stop clarifying" — your next reply MUST be another `<workflow-clarify>` envelope. Do not emit `<workflow-output>`; it will be rejected. The full clarify format and asking-back rules from earlier in this session still apply and have not been re-emitted.',
  'inline-no-channel':
    'Do the work on . Repo at /repo. Iter 2 rem 1.\n\n## Clarify Q&A\n\n1. [q1] Question one?\n   Answer: A1\n\n---\nYou MUST end your reply with a `<workflow-output>` block listing these ports:\n  - out\n\nFormat:\n<workflow-output>\n  <port name="out">...</port>\n</workflow-output>',
  'stop-notice':
    'Do the work on SPEC-CONTENT. Repo at /repo. Iter  rem .\n\n### User directive: STOP CLARIFYING\n- The user has ended clarification. You are now RELEASED from ask-back mode — do NOT emit another <workflow-clarify> envelope.\n- Produce your final <workflow-output> reply now using the answers above. If any detail is still ambiguous, make your best informed call based on the answers and proceed.\n\n---\nYou MUST end your reply with a `<workflow-output>` block listing these ports:\n  - out\n\nFormat:\n<workflow-output>\n  <port name="out">...</port>\n</workflow-output>',
  'prior-output-askback':
    'Do the work on SPEC-CONTENT. Repo at /repo. Iter  rem .\n\n## Prior Output (your previous run\'s output)\n### PRIOR\nold-output\n\n## Prior Output Directive\nThe "Prior Output" section above is what you produced on your previous run of this node. This round is still a clarify-only round — you MUST reply with a single <workflow-clarify> envelope and NO <workflow-output>. Frame your questions around how this prior output should be REVISED — do not re-litigate decisions the user has already settled in the Clarify Q&A. When a Prior Output port is a file path, read that file for its contents before asking.\n\n---\n**This node is in MANDATORY ASK-BACK (clarify) mode.** The user wired a clarify channel because they require you to interrogate intent BEFORE doing any work. Your ONLY valid reply this round is a `<workflow-clarify>` envelope (format below). You may NOT emit `<workflow-output>` — the framework will reject it and re-prompt you. You are released to produce final output only after the user clicks "Stop clarifying".\n\nOperate with ZERO guessing. Treat every unstated detail as a blocker you resolve by asking, never by assuming.\n- **Investigate first, then ask.** Read the inputs, the repository, referenced files, and every prior-round answer; use any skills and tools available to resolve what you can on your own — never spend a question on something you could determine yourself.\n- **Ask the consequential things, in priority order.** Lead with the decisions that most change the outcome (naming, data shapes, API / contracts, UX behavior, scope boundaries, acceptance criteria, risky edge cases). Batch closely-related points into one question. Do NOT pad with low-stakes "just confirming…" questions — depth over breadth.\n- **Pin down every detail that actually matters before acting.** Do not begin the deliverable until each decision needed to do it correctly is settled by the human. "Mostly clear" is not clear enough.\n- **Never guess unfamiliar terms.** Any proprietary term, acronym, internal system / file / convention you do not fully understand — you MUST ask what it means; never infer or invent a meaning.\n- **No assumptions, no fabrication, no silent defaults.** The moment you catch yourself hedging, writing "TBD", inventing a constraint the inputs didn\'t state, or choosing between plausible alternatives without a stated preference — stop and turn it into a question instead.\n- **Ask in the same language as the inputs / the user.**\n- **Asking back is the correct outcome here, not a failure.** Returning early because you "have enough to start" defeats the purpose of this node.\n\n---\n**Clarify format.** Emit exactly one <workflow-clarify> block and nothing else — no <workflow-output> anywhere in the reply. Asking back is the expected outcome of this round.\n\nFormat:\n<workflow-clarify>\n{\n  "questions": [\n    {\n      "id": "<stable-id>",\n      "title": "<question text>",\n      "kind": "single" | "multi",\n      "options": [\n        {\n          "label": "<picker text>",\n          "description": "<what this option does / expected outcome / trade-offs>",\n          "recommended": true | false,\n          "recommendationReason": "<why the user should pick this one>"\n        }\n      ]\n    }\n  ]\n}\n</workflow-clarify>\n\nHard rules — violation is treated as a malformed reply and the node will fail / retry:\n- Your reply MUST contain exactly one <workflow-clarify> block and NO <workflow-output> — emitting <workflow-output> is rejected until the user stops clarifying. Defer all output ports to a later round; do not output partial data.\n- Limits: at most 5 questions, each question 2–4 options — any option beyond the 4th is silently dropped, so cap each question at 4. Do NOT add a "free text / other" option — the framework appends a user-input row automatically.\n- Each option needs a non-empty "label". The other three fields are optional but strongly recommended: "description" (always render an explanation of what picking this option means), and — when "recommended" is true — "recommendationReason" (why this is your pick).\n- Mark at most a couple of options across the whole envelope as "recommended": true. Recommended options sort to the top of the picker for the user.\n- Legacy form is also accepted: `"options": ["a", "b", "c"]` — strings are lifted into `{label, description:"", recommended:false, recommendationReason:""}`. Prefer the structured form for new emissions.\n- Once the user submits answers, you will receive every question answered so far in the next prompt under "## Clarify Q&A" — a single flat list where each question is an equal peer with the user\'s answer (a deterministic synthesis line). Treat every listed answer as an already-resolved decision.',
  'prior-output-update':
    'Do the work on SPEC-CONTENT. Repo at /repo. Iter  rem .\n\n## Prior Output (to update or regenerate)\n### PRIOR\nold-output\n\n## Update Directive\nThe "Prior Output" section above is what you produced on your previous run of this node. This run exists because that output needs to change — see the feedback in the sections above. Update the prior output to address that feedback, preserving the parts it does not contradict; regenerate it from scratch only if the feedback requires fundamental changes. Either way you MUST emit the COMPLETE updated output in the workflow-output envelope — never a diff or a description of changes alone. When a Prior Output port is a file path, read that file for its contents.\n\n---\nYou MUST end your reply with a `<workflow-output>` block listing these ports:\n  - out\n\nFormat:\n<workflow-output>\n  <port name="out">...</port>\n</workflow-output>',
  'prior-output-inline-suppressed':
    'Do the work on . Repo at /repo. Iter 2 rem 1.\n\n## Clarify Q&A\n\n1. [q1] Question one?\n   Answer: A1\n\n---\nThe user has answered your previous `<workflow-clarify>` round (see "Clarify Q&A — User Answers (Current Round)" above). This node stays in MANDATORY ask-back mode until the user clicks "Stop clarifying" — your next reply MUST be another `<workflow-clarify>` envelope. Do not emit `<workflow-output>`; it will be rejected. The full clarify format and asking-back rules from earlier in this session still apply and have not been re-emitted.',
  'review-reject':
    'Do the work on SPEC-CONTENT. Repo at /repo. Iter  rem .\n\n## Review Rejection\nneeds work\n\n## Review Comments\n- fix section 2\n\n---\nYou MUST end your reply with a `<workflow-output>` block listing these ports:\n  - out\n\nFormat:\n<workflow-output>\n  <port name="out">...</port>\n</workflow-output>',
  'review-iterate-siblings':
    'Do the work on SPEC-CONTENT. Repo at /repo. Iter  rem .\n\n## Iterate Target Port\nout\n\n## Sibling Outputs\nKeep these consistent:\n### other\nother-content\n\n---\nYou MUST end your reply with a `<workflow-output>` block listing these ports:\n  - out\n\nFormat:\n<workflow-output>\n  <port name="out">...</port>\n</workflow-output>',
}

const EXPECTED_FOLLOWUP: Record<string, string> = {
  'envelope-missing-nochan':
    '\n\n---\n**Envelope missing — follow-up.** Your previous reply in this session did not contain a `<workflow-output>` envelope. The framework cannot parse your result without it.\n\n- If you have finished the requested work, end your NEXT reply with a `<workflow-output>` block using the EXACT format previously specified in this session (the same port list, the same `<port name="...">...</port>` shape). Do not summarize, do not omit the block.\n- If you were not finished, complete the remaining work first, THEN emit the `<workflow-output>` block. The envelope is mandatory either way.\n- For any list-typed port, re-emit EVERY item using the SAME per-item format previously specified in this session (one item per line, or — for a list of markdown documents — one full body per boundary-separated block). Sending only the first item or a truncated subset is the most common failure; the framework keeps only what this reply contains, so output the complete list.\n- Do not emit anything after the closing `</workflow-output>` tag.',
  'envelope-missing-chan':
    '\n\n---\n**Envelope missing — follow-up.** Your previous reply in this session did not contain either a `<workflow-output>` or a `<workflow-clarify>` envelope. The framework cannot parse your result without exactly one of them.\n\n- This node is in MANDATORY ask-back mode: your reply MUST be exactly one `<workflow-clarify>` block, using the format previously specified in this session. Do NOT emit `<workflow-output>` — it will be rejected until the user clicks "Stop clarifying".\n- If the previous reply was an in-progress draft, finish your investigation first, then ask every still-open question in a single `<workflow-clarify>`.\n- Do not emit anything after the closing `</workflow-clarify>` tag.',
  'both-present':
    '\n\n---\n**Envelope missing — follow-up.** Your previous reply in this session contained BOTH `<workflow-output>` AND `<workflow-clarify>` — the framework requires exactly one. Pick one and re-emit.\n\n- This node is in MANDATORY ask-back mode: your reply MUST be exactly one `<workflow-clarify>` block, using the format previously specified in this session. Do NOT emit `<workflow-output>` — it will be rejected until the user clicks "Stop clarifying".\n- If the previous reply was an in-progress draft, finish your investigation first, then ask every still-open question in a single `<workflow-clarify>`.\n- Do not emit anything after the closing `</workflow-clarify>` tag.',
  'clarify-malformed':
    '\n\n---\n**Envelope missing — follow-up.** Your previous reply in this session contained a `<workflow-clarify>` envelope but its JSON body could not be parsed. Re-emit a valid `<workflow-clarify>` body following the format previously specified in this session.\n\n- This node is in MANDATORY ask-back mode: your reply MUST be exactly one `<workflow-clarify>` block, using the format previously specified in this session. Do NOT emit `<workflow-output>` — it will be rejected until the user clicks "Stop clarifying".\n- If the previous reply was an in-progress draft, finish your investigation first, then ask every still-open question in a single `<workflow-clarify>`.\n- Do not emit anything after the closing `</workflow-clarify>` tag.',
  'clarify-required':
    '\n\n---\n**Envelope missing — follow-up.** Your previous reply in this session did not ask back — it emitted a `<workflow-output>` envelope (or no `<workflow-clarify>` envelope) while this node is in MANDATORY ask-back mode. The framework rejected it. Your next reply MUST be a `<workflow-clarify>` envelope.\n\n- This node is in MANDATORY ask-back mode: your reply MUST be exactly one `<workflow-clarify>` block, using the format previously specified in this session. Do NOT emit `<workflow-output>` — it will be rejected until the user clicks "Stop clarifying".\n- If the previous reply was an in-progress draft, finish your investigation first, then ask every still-open question in a single `<workflow-clarify>`.\n- Do not emit anything after the closing `</workflow-clarify>` tag.',
  'envelope-port-malformed':
    '\n\n---\n**Envelope missing — follow-up.** Your previous reply in this session emitted a `<workflow-output>` envelope, but one or more `<port name="...">` tags were never properly closed — the matching `</port>` was missing or corrupted (for example a stray token turned it into `</|...|port>`), so the framework could not extract those ports. Re-emit the envelope and make sure EVERY port is closed with a literal `</port>` tag — nothing inside the close tag, no extra characters.\n\n- If you have finished the requested work, end your NEXT reply with a `<workflow-output>` block using the EXACT format previously specified in this session (the same port list, the same `<port name="...">...</port>` shape). Do not summarize, do not omit the block.\n- If you were not finished, complete the remaining work first, THEN emit the `<workflow-output>` block. The envelope is mandatory either way.\n- For any list-typed port, re-emit EVERY item using the SAME per-item format previously specified in this session (one item per line, or — for a list of markdown documents — one full body per boundary-separated block). Sending only the first item or a truncated subset is the most common failure; the framework keeps only what this reply contains, so output the complete list.\n- Do not emit anything after the closing `</workflow-output>` tag.',
  'port-validation':
    '\n\n---\n**Port content validation — follow-up.** Your previous reply in this session emitted a `<workflow-output>` envelope, but one or more of its ports failed content validation. Re-emit the envelope with the failing ports fixed per the per-kind notes below.\n\n- If you have finished the requested work, end your NEXT reply with a `<workflow-output>` block using the EXACT format previously specified in this session (the same port list, the same `<port name="...">...</port>` shape). Do not summarize, do not omit the block.\n- If you were not finished, complete the remaining work first, THEN emit the `<workflow-output>` block. The envelope is mandatory either way.\n- For any list-typed port, re-emit EVERY item using the SAME per-item format previously specified in this session (one item per line, or — for a list of markdown documents — one full body per boundary-separated block). Sending only the first item or a truncated subset is the most common failure; the framework keeps only what this reply contains, so output the complete list.\n- Do not emit anything after the closing `</workflow-output>` tag.REPAIR-BLOCK',
  'clarify-malformed-continue':
    '\n\n---\n**Envelope missing — follow-up.** Your previous reply in this session contained a `<workflow-clarify>` envelope but its JSON body could not be parsed. Re-emit a valid `<workflow-clarify>` body following the format previously specified in this session.\n\n- This node is in MANDATORY ask-back mode: your reply MUST be exactly one `<workflow-clarify>` block, using the format previously specified in this session. Do NOT emit `<workflow-output>` — it will be rejected until the user clicks "Stop clarifying".\n- If the previous reply was an in-progress draft, finish your investigation first, then ask every still-open question in a single `<workflow-clarify>`.\n- Do not emit anything after the closing `</workflow-clarify>` tag.\n\nThe user clicked "Keep clarifying" — this node remains in mandatory ask-back mode, so your reply MUST be another `<workflow-clarify>` envelope. `<workflow-output>` is not an option until the user clicks "Stop clarifying".',
}

describe('RFC-148 golden — renderUserPrompt 活组合矩阵', () => {
  for (const [name, input] of Object.entries(RENDER_ROWS)) {
    test(`render:${name}`, () => {
      expect(renderUserPrompt(input as never)).toBe(EXPECTED_RENDER[name]!)
    })
  }

  test('inline 抑制 prior-output：两行字节恒等', () => {
    expect(EXPECTED_RENDER['prior-output-inline-suppressed']).toBe(EXPECTED_RENDER['flat-inline']!)
  })
})

describe('RFC-148 golden — renderEnvelopeFollowupPrompt reason 矩阵', () => {
  for (const [name, input] of Object.entries(FU_ROWS)) {
    test(`followup:${name}`, () => {
      expect(
        renderEnvelopeFollowupPrompt({
          agentOutputs: ['out'],
          agentOutputKinds: { out: 'markdown' },
          ...input,
        } as never),
      ).toBe(EXPECTED_FOLLOWUP[name]!)
    })
  }
})
