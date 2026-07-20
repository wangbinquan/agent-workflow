// RFC-206 T1/T2 — focus-ring clip audit in a REAL layout engine.
//
// WHAT THIS LOCKS: no focusable control's focus indicator may be clipped by an
// ancestor with `overflow != visible`.
//
// WHY IT EXISTS: `outline` (and any non-inset `box-shadow`) paints OUTSIDE the
// border box, while `overflow` clips descendants at the clipping ancestor's
// padding box. A `width: 100%` control is flush against its scroll container by
// construction, so the ring gets eaten. This shipped five times (dialog body
// top, split detail-body left/right, workgroup pane left/bottom, editor form
// grid, agent advanced tab) because:
//   * it is invisible when authoring — adding `overflow: auto` to a container
//     silently breaks rings three levels down;
//   * jsdom has NO layout engine, so every pre-existing test on this is a
//     source-TEXT assertion that can only lock a specific patch's literal —
//     none of them can detect an actual clip;
//   * the first fix patched the CONTAINER, which taught everyone an O(containers)
//     habit, and each patch only covered the one axis that was reported.
//
// See design/RFC-206-focus-ring-clip-elimination/design.md for the full model.

import { test, expect, type Page, type CDPSession } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

/** Seeded so the detail routes below actually render their TabBar + panels —
 *  an empty install shows only the "nothing selected" placeholder, which would
 *  leave `.tabs` (used by EVERY tabbed page) entirely unaudited. */
const SEEDED_AGENT = 'focus-ring-audit-agent'

/** RFC-206 T5' — fixture-backed surfaces. The list/new routes render from an
 *  empty install, but the heaviest chrome in the app (workflow editor
 *  inspector + sidebar, task detail panes) only mounts with real data, so
 *  without these seeds those surfaces stay completely unaudited. */
let seededWorkflowId = ''
let seededTaskId = ''
/** node_run id of a task parked at awaiting_review — the /reviews/{id} page. */
let seededReviewId = ''
/** A workgroup task, so the chatroom pane (member cards, run log) renders. */
let seededWorkgroupTaskId = ''

async function api(path: string, body: unknown): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  const res = await api('/api/agents', {
    name: SEEDED_AGENT,
    description: 'RFC-206 focus-ring clip audit fixture',
    outputs: ['answer'],
    // markdown kind is required by the review node's inputSource check, and it
    // also makes the task detail output pane render its rich (not raw) view.
    outputKinds: { answer: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
  expect(res.ok, `failed to seed agent (${res.status})`).toBe(true)

  const wfRes = await api('/api/workflows', {
    name: 'focus-ring-audit-workflow',
    description: 'RFC-206 focus-ring clip audit fixture',
    definition: {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'agent_1',
          kind: 'agent-single',
          agentName: SEEDED_AGENT,
          promptTemplate: 'Explain {{topic}} briefly.',
          position: { x: 320, y: 0 },
        },
        {
          id: 'out_1',
          kind: 'output',
          ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
          position: { x: 640, y: 0 },
        },
      ],
      edges: [
        {
          id: 'e_in_agent',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'agent_1', portName: 'topic' },
        },
        {
          id: 'e_agent_out',
          source: { nodeId: 'agent_1', portName: 'answer' },
          target: { nodeId: 'out_1', portName: 'answer' },
        },
      ],
    },
  })
  expect(wfRes.ok, `failed to seed workflow (${wfRes.status})`).toBe(true)
  seededWorkflowId = ((await wfRes.json()) as { id: string }).id

  const taskRes = await api('/api/tasks', {
    workflowId: seededWorkflowId,
    name: 'Focus ring audit task',
    scratch: true,
    inputs: { topic: 'clipped focus rings' },
  })
  expect(taskRes.ok, `failed to seed task (${taskRes.status})`).toBe(true)
  seededTaskId = ((await taskRes.json()) as { id: string }).id

  // Drive it to a terminal state so the detail page renders its real panes
  // (outputs, worktree diff, run log) rather than a spinner.
  const deadline = Date.now() + 60_000
  for (;;) {
    const r = await fetch(`${daemon.baseUrl}/api/tasks/${seededTaskId}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    if (r.ok) {
      const { status } = (await r.json()) as { status: string }
      if (['done', 'failed', 'canceled', 'interrupted'].includes(status)) break
    }
    expect(Date.now() < deadline, 'seeded task never reached a terminal state').toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  // ── T5' batch 2 fixtures ──────────────────────────────────────────────
  // A task parked at awaiting_review, so /reviews/{id} renders its real
  // two-pane layout (.review-detail__layout has padding-right only).
  const revWf = (await api('/api/workflows', {
    name: 'focus-ring-audit-review-wf',
    description: 'RFC-206 review-surface fixture',
    definition: {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'agent_1',
          kind: 'agent-single',
          agentName: SEEDED_AGENT,
          promptTemplate: 'Write a design for {{topic}}.',
          position: { x: 320, y: 0 },
        },
        {
          id: 'review_1',
          kind: 'review',
          title: 'focus ring audit review',
          description: '',
          inputSource: { nodeId: 'agent_1', portName: 'answer' },
          rerunnableOnReject: [],
          rerunnableOnIterate: [],
          rollbackFilesOnReject: false,
          rollbackFilesOnIterate: false,
          position: { x: 640, y: 0 },
        },
        {
          id: 'out_1',
          kind: 'output',
          ports: [{ name: 'doc', bind: { nodeId: 'review_1', portName: 'approved_doc' } }],
          position: { x: 960, y: 0 },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'agent_1', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'agent_1', portName: 'answer' },
          target: { nodeId: 'review_1', portName: '__review_input__' },
        },
        {
          id: 'e3',
          source: { nodeId: 'review_1', portName: 'approved_doc' },
          target: { nodeId: 'out_1', portName: 'doc' },
        },
      ],
    },
  })) as Response
  expect(revWf.ok, `failed to seed review workflow (${revWf.status})`).toBe(true)
  {
    const revWfId = ((await revWf.json()) as { id: string }).id
    const revTask = await api('/api/tasks', {
      workflowId: revWfId,
      name: 'Focus ring audit review task',
      scratch: true,
      inputs: { topic: 'focus rings' },
    })
    expect(revTask.ok, `failed to launch review task (${revTask.status})`).toBe(true)
    {
      const revTaskId = ((await revTask.json()) as { id: string }).id
      const revDeadline = Date.now() + 60_000
      while (Date.now() < revDeadline) {
        const r = await fetch(`${daemon.baseUrl}/api/reviews?status=pending`, {
          headers: { Authorization: `Bearer ${daemon.token}` },
        })
        if (r.ok) {
          const rows = (await r.json()) as Array<{
            taskId: string
            nodeRunId: string
            awaitingReview: boolean
          }>
          const row = rows.find((x) => x.taskId === revTaskId && x.awaitingReview)
          if (row) {
            seededReviewId = row.nodeRunId
            break
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      expect(seededReviewId, 'review task never parked at awaiting_review').not.toBe('')
    }
  }

  // A workgroup task, so the chatroom pane renders member cards + run log —
  // where T4's "focus ring 100% invisible" bug lived, found by the STATIC
  // audit because the geometry audit could not reach this surface.
  const wg = await api('/api/workgroups', {
    name: 'focus-ring-audit-wg',
    description: '',
    instructions: '',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    maxRounds: 2,
    completionGate: false,
    members: [
      { memberType: 'agent', agentName: SEEDED_AGENT, displayName: 'Lead' },
      { memberType: 'agent', agentName: SEEDED_AGENT, displayName: 'Member' },
    ],
  })
  expect(wg.ok, `failed to seed workgroup (${wg.status})`).toBe(true)
  const wgTask = await api('/api/workgroups/focus-ring-audit-wg/tasks', {
    name: 'Focus ring audit workgroup task',
    goal: 'audit the focus rings',
    scratch: true,
  })
  expect(wgTask.ok, `failed to launch workgroup task (${wgTask.status})`).toBe(true)
  seededWorkgroupTaskId = ((await wgTask.json()) as { id: string }).id

  // Settle it before auditing. The chatroom pane is WS-driven, so a still-running
  // workgroup task keeps re-rendering under the audit — tagged nodes disappear
  // mid-measurement and coverage silently drops. Terminal (or parked) is enough.
  const wgDeadline = Date.now() + 90_000
  while (Date.now() < wgDeadline) {
    const r = await fetch(`${daemon.baseUrl}/api/tasks/${seededWorkgroupTaskId}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    if (r.ok) {
      const { status } = (await r.json()) as { status: string }
      if (
        ['done', 'failed', 'canceled', 'interrupted', 'awaiting_review', 'awaiting_human'].includes(
          status,
        )
      )
        break
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// CDP (`CSS.forcePseudoState`) is Chrome-only. The default PR-gating project is
// chromium; webkit is opt-in nightly (playwright.config.ts), so skipping there
// costs no coverage on the gating path.
test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'focus-ring geometry audit needs CDP CSS.forcePseudoState (chromium only)',
)

// ───────────────────────── in-page audit engine ─────────────────────────
//
// Serialized into the page by page.evaluate. Kept as one self-contained source
// string because Playwright cannot serialize closures over module scope.

const AUDIT_ENGINE = `
(() => {
  const SIDES = ['top', 'right', 'bottom', 'left'];

  // Split a comma-separated CSS value at TOP-LEVEL commas only. A naive
  // /,(?![^(]*\\))/ tears 'color-mix(in srgb, a, b)' apart — the lookahead
  // cannot see past a nested '('. Depth counting is the only correct way.
  function splitLayers(value) {
    const out = []; let depth = 0; let cur = '';
    for (const ch of value) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim() !== '') out.push(cur);
    return out;
  }

  // Lengths of a box-shadow layer, with functional colors (rgb(), rgba(),
  // color-mix()) stripped first so their numeric args are not miscounted.
  function lengthsOf(layer) {
    const stripped = layer.replace(/[a-z-]+\\([^()]*(\\([^()]*\\)[^()]*)*\\)/gi, ' ');
    return (stripped.match(/-?(?:\\d*\\.)?\\d+px/g) || []).map(parseFloat);
  }

  // How far the focus indicator paints OUTSIDE the border box, per side.
  function inkOf(cs) {
    const ink = { top: 0, right: 0, bottom: 0, left: 0 };
    if (cs.outlineStyle !== 'none') {
      let v = (parseFloat(cs.outlineWidth) || 0) + (parseFloat(cs.outlineOffset) || 0);
      // outline-style:auto is Chrome's UA focus ring, and getComputedStyle
      // UNDER-REPORTS it: Chrome says auto/1px/offset-0 but actually paints
      // ~2px outside the border box. Measured by rendering the same focused
      // button inside clippers with padding 0..4 and magnifying: padding 0 and
      // 1 are visibly cut, 2 is clean. Trusting the reported 1px would let a
      // container with 1px of room pass while the ring is visibly clipped —
      // a false negative of exactly the kind this audit exists to prevent.
      // Locked by the 'UA auto ring' self-check below.
      if (cs.outlineStyle === 'auto') v = Math.max(v, 2);
      if (v > 0) for (const s of SIDES) ink[s] = Math.max(ink[s], v);
    }
    if (cs.boxShadow && cs.boxShadow !== 'none') {
      for (const layer of splitLayers(cs.boxShadow)) {
        if (/\\binset\\b/.test(layer)) continue;
        const n = lengthsOf(layer);
        if (n.length < 2) continue;
        const dx = n[0], dy = n[1], blur = n[2] || 0, spread = n[3] || 0;
        // blur counts: 'box-shadow: 0 0 4px c' has no spread but still bleeds.
        ink.left = Math.max(ink.left, spread + blur - dx);
        ink.right = Math.max(ink.right, spread + blur + dx);
        ink.top = Math.max(ink.top, spread + blur - dy);
        ink.bottom = Math.max(ink.bottom, spread + blur + dy);
      }
    }
    return ink;
  }

  function isClipper(cs) {
    return cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
  }

  // Clip box = padding box, widened by overflow-clip-margin (which only
  // applies to 'overflow: clip', never to auto/scroll).
  function clipBox(el, cs) {
    const r = el.getBoundingClientRect();
    const m = (cs.overflowX === 'clip' || cs.overflowY === 'clip')
      ? (parseFloat(cs.overflowClipMargin) || 0) : 0;
    return {
      top: r.top + (parseFloat(cs.borderTopWidth) || 0) - m,
      bottom: r.bottom - (parseFloat(cs.borderBottomWidth) || 0) + m,
      left: r.left + (parseFloat(cs.borderLeftWidth) || 0) - m,
      right: r.right - (parseFloat(cs.borderRightWidth) || 0) + m,
    };
  }

  function label(el) {
    const cls = (el.className && el.className.toString().trim().split(/\\s+/)[0]) || '';
    return cls ? '.' + cls : el.tagName.toLowerCase();
  }

  // Measure one rect (the element's own border box, or a stretch pseudo's box)
  // against every clipping ancestor. Returns violations.
  function measureRect(el, rect, ink, kind) {
    const out = [];
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (!isClipper(ps)) continue;
      const box = clipBox(p, ps);

      const room = {
        top: rect.top - box.top,
        bottom: box.bottom - rect.bottom,
        left: rect.left - box.left,
        right: box.right - rect.right,
      };
      for (const s of SIDES) {
        // Negative room means the element already extends PAST this edge —
        // either scrolled out of the scrollport, or deliberately overhanging
        // (e.g. .tabs__tab has margin-bottom:-1px to sit on the rail's border).
        // Either way this side is unjudgeable, so skip THIS SIDE ONLY.
        //
        // This used to be an all-or-nothing "is the element fully inside?"
        // gate, which was a silent false negative: .tabs__tab pokes 1px below
        // .tabs, so the gate discarded the clipper entirely and hid the REAL
        // top/left clips (ink 4 vs room 0). Locked by the overhang self-check.
        // Tolerance mirrors the violation threshold below. Using a hard < 0
        // meant a control pushed to -0.001 by flex/grid fractional widths lost
        // that entire side — and a width:100% element with negative inline
        // margins lost BOTH inline sides, i.e. the worst-clipped cases went
        // silent. Sub-pixel overhang is rounding, not an intentional overhang.
        if (room[s] < -0.5) continue;
        if (ink[s] > 0 && room[s] < ink[s] - 0.5) {
          out.push({
            kind, control: label(el), clipper: label(p), side: s,
            ink: Math.round(ink[s] * 10) / 10,
            room: Math.round(room[s] * 10) / 10,
            text: (el.textContent || '').trim().slice(0, 24),
            box: [Math.round(rect.left), Math.round(rect.top)],
          });
        }
      }
    }
    return out;
  }

  function auditOne(el) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return [];
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    // position:fixed escapes ancestor overflow clipping entirely.
    if (cs.position === 'fixed') return [];

    const found = [];
    const ink = inkOf(cs);
    if (SIDES.some((s) => ink[s] > 0)) found.push(...measureRect(el, rect, ink, 'self'));

    // :focus-within rings live on ANCESTORS that are usually not focusable
    // themselves, so they never appear in the candidate set and would never be
    // measured. This repo has exactly that shape — .user-picker
    // .chips-input__row:focus-within paints a ring on a plain <div> wrapper —
    // meaning a rule RFC-206 itself edited was geometrically unverifiable.
    // With :focus forced on the candidate, ancestors already match
    // :focus-within, so their computed style is live here: walk up and measure
    // any ancestor that is now painting a ring of its own.
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const as2 = getComputedStyle(a);
      const aInk = inkOf(as2);
      if (!SIDES.some((s) => aInk[s] > 0)) continue;
      const ar = a.getBoundingClientRect();
      if (!ar.width || !ar.height) continue;
      if (as2.position === 'fixed') continue;
      found.push(...measureRect(a, ar, aInk, 'focus-within'));
    }

    // Stretch-overlay pseudo rings (.workgroup-card__open::after,
    // .gallery-card__stretch::after): an absolutely positioned ::after with
    // all-zero insets. Its containing block is the nearest POSITIONED ancestor
    // (offsetParent), NOT the element itself — that is exactly why
    // .workgroup-card__open's ring is swallowed whole by .split-card.
    for (const pseudo of ['::before', '::after']) {
      const as = getComputedStyle(el, pseudo);
      if (as.content === 'none' || as.position !== 'absolute') continue;
      // OUTLINE only for pseudos. Counting box-shadow here produces false
      // positives from purely decorative pseudos — e.g. the switch thumb
      // (.form-switch > input::before) is an absolutely positioned dot with a
      // drop shadow and no focus semantics at all. Every real pseudo-hosted
      // focus ring in this codebase (.workgroup-card__open::after,
      // .gallery-card__stretch::after) uses outline.
      const pInk = { top: 0, right: 0, bottom: 0, left: 0 };
      if (as.outlineStyle !== 'none') {
        const pv = (parseFloat(as.outlineWidth) || 0) + (parseFloat(as.outlineOffset) || 0);
        if (pv > 0) for (const s of SIDES) pInk[s] = pv;
      }
      if (!SIDES.some((s) => pInk[s] > 0)) continue;
      const zeroInset = SIDES.every((s) => (parseFloat(as[s]) || 0) === 0);
      const host = el.offsetParent;
      if (!zeroInset || !host) {
        found.push({ kind: 'pseudo-unknown', control: label(el) + pseudo,
                     clipper: '?', side: '?', ink: -1, room: -1, text: '', box: [0, 0] });
        continue;
      }
      const hs = getComputedStyle(host);
      const hr = host.getBoundingClientRect();
      const pseudoRect = {
        top: hr.top + (parseFloat(hs.borderTopWidth) || 0),
        bottom: hr.bottom - (parseFloat(hs.borderBottomWidth) || 0),
        left: hr.left + (parseFloat(hs.borderLeftWidth) || 0),
        right: hr.right - (parseFloat(hs.borderRightWidth) || 0),
      };
      found.push(...measureRect(el, pseudoRect, pInk, 'pseudo'));
    }
    return found;
  }

  window.__frAudit = {
    // Focusability ORACLE, not a hand-written selector list. A list like
    // 'button, a[href], input, textarea, select, [tabindex]' silently omits
    // <summary> — natively keyboard-focusable, 29 of them in this frontend,
    // and the shared FormSection primitive IS a <details>/<summary>.
    tag() {
      const base = document.querySelectorAll(
        'button, a[href], input, textarea, select, summary, [contenteditable=""],' +
        '[contenteditable="true"], audio[controls], video[controls],' +
        '[tabindex]:not([tabindex="-1"])'
      );
      let i = 0;
      for (const el of base) {
        if (el.disabled) continue;
        if (el.closest('[inert]') || el.closest('[aria-hidden="true"]')) continue;
        if (el.tagName === 'SUMMARY' && !(el.parentElement && el.parentElement.tagName === 'DETAILS')) continue;
        el.setAttribute('data-fr-audit', String(i++));
      }
      return i;
    },
    // NOTE: measured ONE INSTANCE AT A TIME, on purpose. Never collapse
    // candidates by class+clipper before measuring: clipping depends on
    // POSITION. In a scroll list ten .btn share a class and a clipper, but only
    // the last one is flush with the bottom edge — a "representative" sample
    // would test a safe interior instance and pass the whole group while a real
    // ring is being cut. Dedup, if any, happens after measurement.
    measure(i) {
      const el = document.querySelector('[data-fr-audit="' + i + '"]');
      // Report whether the node still existed. tag() runs once, then each node
      // takes 3 cross-process round trips (querySelector -> forcePseudoState ->
      // evaluate); a React re-render inside that window makes the tagged node —
      // and its data-fr-audit — disappear. Returning a bare [] there is
      // indistinguishable from "measured it, found nothing", and the coverage
      // number (taken from tag()) would still count it as covered. That is the
      // exact假绿 this audit exists to prevent, so the count must come from
      // here, not from tag().
      if (el === null) return { alive: false, inMain: false, violations: [] };
      // Coverage must count only controls in the MAIN region. The shell nav
      // (.sidebar / mobile topbar) renders on every route, so a whole-document
      // count is >= 10 even when the surface itself rendered empty — the gate
      // would then only ever catch "the page did not load at all".
      const inMain = el.closest('.content') !== null && el.closest('.sidebar') === null;
      return { alive: true, inMain, violations: auditOne(el) };
    },
    untag() {
      for (const el of document.querySelectorAll('[data-fr-audit]')) el.removeAttribute('data-fr-audit');
    },
    // Diagnostics for a specific selector regardless of whether it violates —
    // used to VERIFY a "this is clipped" claim instead of trusting it.
    probe(i, selector) {
      const el = document.querySelector('[data-fr-audit="' + i + '"]');
      if (!el || !el.matches(selector)) return null;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const out = { control: label(el), ink: inkOf(cs),
                    outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' off ' + cs.outlineOffset,
                    clippers: [] };
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (!isClipper(ps)) continue;
        const box = clipBox(p, ps);
        out.clippers.push({ clipper: label(p), padding: ps.padding,
          overflow: ps.overflowX + '/' + ps.overflowY,
          room: { top: +(rect.top - box.top).toFixed(1), bottom: +(box.bottom - rect.bottom).toFixed(1),
                  left: +(rect.left - box.left).toFixed(1), right: +(box.right - rect.right).toFixed(1) } });
      }
      return out;
    },
  };
})()
`

interface Violation {
  kind: string
  control: string
  clipper: string
  side: string
  ink: number
  room: number
  text: string
  box: [number, number]
}

declare global {
  interface Window {
    __frAudit: {
      tag(): number
      measure(i: number): { alive: boolean; inMain: boolean; violations: Violation[] }
      untag(): void
    }
  }
}

/**
 * Drive the audit over one page.
 *
 * ⚠️ The CDP force is the whole ballgame — see design.md §3.2. `:focus-visible`
 * matching depends on the browser's "was the last input keyboard or pointer"
 * heuristic, NOT on how focus was set. Measured four ways:
 *   fresh page + el.focus()            → matches,     ink 4
 *   after ONE real mouse click         → NO match,    ink 0   ← silent hole
 *   CDP forced                         → matches,     ink 4
 *   forced state cleared               → NO match,    ink 0
 * So any spec that clicks anything — i.e. every realistic flow — loses all
 * :focus-visible coverage from that point on. That is PARTIAL vacuity: the
 * total stays non-zero, so a naive "it found some violations, so it works"
 * sanity check still passes while most of the surface is dark.
 */
async function auditPage(
  page: Page,
  cdp: CDPSession,
): Promise<{ found: Violation[]; measured: number }> {
  await page.evaluate(AUDIT_ENGINE)
  const count = await page.evaluate(() => window.__frAudit.tag())

  // nodeIds are invalidated by navigation — always re-root per page.
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const found: Violation[] = []
  let measured = 0 // main-region only — see measure()'s inMain
  let alive = 0

  for (let i = 0; i < count; i++) {
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: `[data-fr-audit="${i}"]`,
    })
    if (!nodeId) continue
    await cdp.send('CSS.forcePseudoState', {
      nodeId,
      forcedPseudoClasses: ['focus', 'focus-visible'],
    })
    const r = (await page.evaluate((n) => window.__frAudit.measure(n), i)) as {
      alive: boolean
      inMain: boolean
      violations: Violation[]
    }
    if (r.alive) {
      alive += 1
      if (r.inMain) measured += 1
    }
    found.push(...r.violations)
    // Clearing is mandatory: forced state is per-node and persistent, so
    // leaving it on pollutes later measurements (e.g. an ancestor that would
    // then match :focus-within).
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
  }

  await page.evaluate(() => window.__frAudit.untag())
  // `count` is what tag() SAW; `measured` is what actually got measured. They
  // differ whenever the DOM churned mid-audit — surface that rather than hide it.
  if (alive < count) {
    console.log(`[focus-ring] ${count - alive}/${count} tagged nodes vanished mid-audit`)
  }
  return { found, measured }
}

/** Assign a per-instance occurrence index so one waiver cannot cover a NEW
 *  clipped sibling of the same class (design.md §3.5). */
function keyed(route: string, violations: Violation[]): Array<{ key: string; v: Violation }> {
  const seen = new Map<string, number>()
  return violations.map((v) => {
    const stem = `${route}::${v.control}::${v.clipper}::${v.side}`
    const n = seen.get(stem) ?? 0
    seen.set(stem, n + 1)
    return { key: `${stem}::${n}`, v }
  })
}

function describe(v: Violation): string {
  return (
    `    [${v.kind}] ${v.control} inside ${v.clipper} — ${v.side} edge clipped: ` +
    `ring paints ${v.ink}px out, only ${v.room}px of room` +
    (v.text ? ` (text: "${v.text}")` : '') +
    ` @ (${v.box[0]},${v.box[1]})`
  )
}

// ───────────────────────── baseline allowlist ─────────────────────────
//
// key -> reason (mandatory).
//
// EMPTY, and it must stay that way — this audit is in hard-failure mode.
//
// It opened at 37 entries (T2 baseline) from four root causes; T3/T4 cleared
// all of them, so there is no such thing as a "pre-existing" clip any more.
// Adding an entry here is claiming a clipped focus ring is acceptable, which
// needs an RFC-206 amendment and a reason string saying who it is waived for.
// Prefer the two real fixes:
//   * the control is flush by construction  -> give it the INSET ring
//                                              (var(--focus-ring-offset-inset))
//   * the container merely lacks room       -> give it var(--focus-ring-gutter)
const KNOWN_CLIPS = new Map<string, string>()

// ───────────────────────── engine self-checks ─────────────────────────
//
// These run FIRST and guard against the audit degrading into a green no-op.
// design.md §3.2.1 / §6.2 / §6.3.

test.describe('RFC-206 — audit engine self-checks', () => {
  test('CDP forcing is what makes :focus-visible measurable (4-scenario probe)', async ({
    page,
  }) => {
    await page.setContent(`<!doctype html><meta charset=utf-8>
      <style>.b{display:block;width:120px;height:30px}
      .b:focus-visible{outline:2px solid #1f5fda;outline-offset:2px}</style>
      <button class="b" id="a">a</button><button class="b" id="b">b</button>`)
    const read = () =>
      page.$eval('#b', (el) => {
        const cs = getComputedStyle(el)
        return cs.outlineStyle === 'none'
          ? 0
          : parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset)
      })

    await page.$eval('#b', (el) => (el as HTMLElement).focus())
    expect(await read(), 'fresh page: programmatic focus does match :focus-visible').toBe(4)

    await page.click('#a') // one real pointer interaction
    await page.$eval('#b', (el) => {
      ;(el as HTMLElement).blur()
      ;(el as HTMLElement).focus()
    })
    expect(
      await read(),
      'after a real click, programmatic focus NO LONGER matches :focus-visible — ' +
        'this is the silent hole CDP forcing exists to close',
    ).toBe(0)

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#b',
    })
    await cdp.send('CSS.forcePseudoState', {
      nodeId,
      forcedPseudoClasses: ['focus', 'focus-visible'],
    })
    expect(await read(), 'CDP forcing restores the ring regardless of interaction history').toBe(4)

    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
    expect(await read(), 'clearing the forced state works (required for hygiene)').toBe(0)
    await cdp.detach()
  })

  test('detects a planted clip, a <summary>, and the LAST instance of a repeated control', async ({
    page,
  }) => {
    // The list is the important one: interior buttons are safe, only the last
    // is flush with the bottom edge. An audit that collapsed candidates by
    // class+clipper before measuring would sample a safe interior instance and
    // report the whole group green (design.md §6.2).
    // height 90px == exactly three 30px rows, so ONLY the third is flush with
    // the bottom clip edge. Interior rows have room on that side.
    await page.setContent(`<!doctype html><meta charset=utf-8>
      <style>
        .clip{overflow:auto;width:220px;height:90px;padding:0;background:#eee}
        .btn{display:block;width:100%;height:30px;margin:0;border:0}
        .btn:focus-visible{outline:2px solid #1f5fda;outline-offset:2px}
        summary:focus-visible{outline:2px solid #1f5fda;outline-offset:2px}
      </style>
      <div class="clip" id="list">
        <button class="btn">one</button>
        <button class="btn">two</button>
        <button class="btn" id="last">three</button>
      </div>
      <div class="clip"><details><summary id="sum">more</summary><p>body</p></details></div>`)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { found } = await auditPage(page, cdp)
    await cdp.detach()

    expect(
      found.length,
      `expected planted clips, got:\n${found.map(describe).join('\n')}`,
    ).toBeGreaterThan(0)
    // Only the LAST button is flush with the scroll box's bottom edge. If the
    // audit ever collapses candidates by class+clipper before measuring, a safe
    // interior instance represents the group and this goes green while a real
    // ring is cut — so assert the bottom clip is reported AND that it belongs
    // to the third button specifically.
    const bottomClips = found.filter((v) => v.control === '.btn' && v.side === 'bottom')
    expect(
      bottomClips.map((v) => v.text),
      `expected exactly the LAST .btn to report a bottom clip — did something dedup ` +
        `before measuring?\n${found.map(describe).join('\n')}`,
    ).toEqual(['three'])
    // <summary> must be in the candidate set at all.
    expect(
      found.some((v) => v.control === 'summary' || v.control === '.clip'),
      `no <summary> finding — the focusability oracle is missing native focusables:\n${found.map(describe).join('\n')}`,
    ).toBe(true)
  })

  test('still judges the other sides when a control overhangs ONE edge', async ({ page }) => {
    // Regression: .tabs__tab carries margin-bottom:-1px so it sits on the tab
    // rail's border, i.e. it pokes 1px BELOW its overflow:auto parent. An
    // all-or-nothing "fully inside the scrollport?" gate discarded that clipper
    // outright and silently hid the real top/left clips (ink 4 vs room 0) —
    // the audit reported the app's most-used tab strip as clean. Sides must be
    // judged independently.
    // Mirrors the real geometry: .tabs has `border-bottom: 1px`, so its clip
    // box (= padding box) ends 1px above its border-box bottom, while the tab
    // stretches to the full border-box height. Net: room.bottom === -1.
    await page.setContent(`<!doctype html><meta charset=utf-8>
      <style>
        .rail{overflow:auto;width:240px;height:30px;padding:0;
              border-bottom:1px solid #999;background:#eee}
        .tab{height:31px;border:0;background:none}
        .tab:focus-visible{outline:2px solid #1f5fda;outline-offset:2px}
      </style>
      <div class="rail"><button class="tab">one</button></div>`)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { found } = await auditPage(page, cdp)
    await cdp.detach()

    const sides = found
      .filter((v) => v.control === '.tab')
      .map((v) => v.side)
      .sort()
    expect(
      sides,
      `overhanging control must still be judged on its other edges, got:\n${found.map(describe).join('\n')}`,
    ).toEqual(['left', 'top'])
  })

  test('measures the UA `outline-style: auto` ring at its PAINTED width', async ({ page }) => {
    // getComputedStyle reports `auto 1px / offset 0`, but Chrome paints ~2px
    // outside. A clipper with exactly 1px of room therefore visibly cuts the
    // ring while a naive reading says it fits. Empirically verified by
    // magnified screenshots (padding 0 and 1 clipped, 2 clean).
    await page.setContent(`<!doctype html><meta charset=utf-8>
      <style>
        .clip{overflow:hidden;display:inline-block;background:#eee}
        .btn{display:block;width:90px;height:22px}
      </style>
      <span class="clip" style="padding:1px"><button class="btn" id="tight">b</button></span>`)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { found } = await auditPage(page, cdp)
    await cdp.detach()
    expect(
      found.length,
      `a UA-focus-ring button with only 1px of room must be reported; got:\n${found.map(describe).join('\n')}`,
    ).toBeGreaterThan(0)
    expect(found.every((v) => v.ink >= 2)).toBe(true)
  })

  test('detects a :focus-within ring painted on a NON-focusable ancestor', async ({ page }) => {
    // The wrapper is a plain <div> with no tabindex, so it is never a candidate;
    // only walking up from the focused child finds its ring. This repo really
    // has this shape (.user-picker .chips-input__row:focus-within on a div),
    // and RFC-206 edited that very rule — without this path the edit would be
    // geometrically unverifiable.
    await page.setContent(`<!doctype html><meta charset=utf-8>
      <style>
        .clip{overflow:auto;width:220px;height:60px;padding:0;background:#eee}
        .row{display:flex;width:100%;box-sizing:border-box;border:1px solid #999}
        .row:focus-within{outline:2px solid #1f5fda;outline-offset:2px}
        .row input{flex:1;border:0;min-width:0}
      </style>
      <div class="clip"><div class="row"><input id="i"></div></div>`)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { found } = await auditPage(page, cdp)
    await cdp.detach()
    expect(
      found.filter((v) => v.kind === 'focus-within' && v.control === '.row').length,
      `the wrapper's :focus-within ring must be measured; got:\n${found.map(describe).join('\n')}`,
    ).toBeGreaterThan(0)
  })

  test('does not report elements scrolled out of the scrollport', async ({ page }) => {
    await page.setContent(`<!doctype html><meta charset=utf-8>
      <style>
        .clip{overflow:auto;width:220px;height:60px;padding:8px;background:#eee}
        .btn{display:block;width:100%;height:30px}
        .btn:focus-visible{outline:2px solid #1f5fda;outline-offset:2px}
      </style>
      <div class="clip" id="s">${'<button class="btn">x</button>'.repeat(20)}</div>`)
    await page.$eval('#s', (el) => (el.scrollTop = 200))
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { found } = await auditPage(page, cdp)
    await cdp.detach()
    // 8px padding ≥ 4px ring, so nothing here is a real clip; the partially
    // scrolled-out rows must not be mistaken for one.
    expect(found.map(describe).join('\n')).toBe('')
  })
})

// ───────────────────────── route sweep ─────────────────────────

async function primeAuth(page: Page, d: DaemonHandle): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: d.baseUrl, token: d.token },
  )
}

/** Routes re-swept at <=720px, where styles.css swaps in a different container
 *  regime. Kept to a representative subset so the extra pass stays cheap. */
const NARROW_ROUTES = ['/agents', '/tasks', '/workflows', '/settings', '/memory', '/clarify']

const ROUTES = [
  '/',
  '/agents',
  '/agents/new',
  '/workflows',
  '/tasks',
  '/tasks/new',
  '/repos',
  '/skills',
  '/skills/new',
  '/mcps',
  '/mcps/new',
  '/plugins',
  '/plugins/new',
  '/memory',
  '/settings',
  '/reviews',
  '/clarify',
  '/scheduled',
  '/workgroups',
  '/users',
  '/account',
]

/**
 * ONE test sweeps everything, on purpose.
 *
 * The obvious shape — one test per route plus a final "no stale entries" test
 * reading a module-level Set — is BROKEN under Playwright: the runner tears
 * down and restarts the worker process after every failing test, so
 * module-level accumulation silently resets mid-run. The stale-entry check
 * would then see a partial picture and start reporting live waivers as stale
 * (or, once the allowlist is empty, quietly verify nothing). A guard that
 * misreports is worse than no guard, so the sweep and both assertions live in
 * a single test where the state cannot be lost.
 *
 * Per-route granularity is preserved in the failure message instead.
 */
test('focus rings are not clipped anywhere', async ({ page }) => {
  test.setTimeout(240_000)
  await primeAuth(page, daemon)

  const cdp = await page.context().newCDPSession(page)
  const seen = new Set<string>()
  const blocking: Array<{ route: string; v: Violation }> = []

  // Which surfaces were actually reached, and how many controls each one
  // measured. A fixture that silently fails to render would otherwise show up
  // as "0 violations" — indistinguishable from "clean" — which is the exact
  // vacuity failure this whole RFC exists to prevent. Asserted at the end.
  const coverage = new Map<string, number>()

  const record = (route: string, result: { found: Violation[]; measured: number }) => {
    const { found, measured } = result
    coverage.set(route, (coverage.get(route) ?? 0) + measured)
    for (const { key, v } of keyed(route, found)) {
      seen.add(key)
      if (!KNOWN_CLIPS.has(key)) blocking.push({ route, v })
    }
  }

  const sweep = async (): Promise<{ found: Violation[]; measured: number }> => {
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    return auditPage(page, cdp)
  }

  for (const route of ROUTES) {
    await page.goto(`${daemon.baseUrl}${route}`)
    await expect(page.locator('.app-shell, .page, main').first()).toBeVisible()
    await page.waitForTimeout(300) // let lazy panels settle
    record(route, await sweep())
  }

  // The canonical tabbed surface: mounts `.tabs` (TabBar, used by every tabbed
  // page) and five keep-mounted panels of which only the active one is laid
  // out — hidden panels are display:none and skipped, so visit each tab.
  await page.goto(`${daemon.baseUrl}/agents/${SEEDED_AGENT}`)
  await expect(page.locator('.agent-form')).toBeVisible()
  const tabs = page.locator('[role="tab"]')
  const tabCount = await tabs.count()
  expect(tabCount, 'agent detail should mount its TabBar').toBeGreaterThan(1)
  for (let i = 0; i < tabCount; i++) {
    await tabs.nth(i).click()
    await page.waitForTimeout(200)
    record('/agents/{name}(tabs)', await sweep())
  }

  // ── RFC-206 T5': fixture-backed surfaces ──────────────────────────────
  // These carry the app's densest chrome and none of it renders on an empty
  // install, so before T5' they were entirely unaudited.

  // Workflow editor: canvas + right inspector + left node sidebar. Its panels
  // are the zero-padding scroll boxes the static audit flagged (.inspector,
  // .editor-sidebar, .workflow-node-picker__groups).
  await page.goto(`${daemon.baseUrl}/workflows/${seededWorkflowId}`)
  await expect(page.locator('.workflow-canvas, .canvas-frame').first()).toBeVisible()
  await page.waitForTimeout(1200) // xyflow mounts asynchronously
  record('/workflows/{id}(editor)', await sweep())

  // …and again with a node selected, which is the only way the right-hand
  // inspector (its own scroll box, full-width form controls) ever mounts.
  const node = page.locator('.react-flow__node').first()
  if (await node.count()) {
    await node.click()
    await page.waitForTimeout(500)
    record('/workflows/{id}(editor+inspector)', await sweep())
  }

  // Task detail: .task-detail__pane is overflow:auto with NO padding of its
  // own — only `> .workgroup-room` was ever protected, so every other pane is
  // unguarded. Walk its tabs the same way as the agent form.
  await page.goto(`${daemon.baseUrl}/tasks/${seededTaskId}`)
  await expect(page.locator('.page--task-detail, .task-detail__panes').first()).toBeVisible()
  await page.waitForTimeout(600)
  record('/tasks/{id}', await sweep())
  // Task detail navigates by `?tab=` (PageSectionNav, not a role=tab TabBar),
  // so drive it by URL — deterministic, and it avoids the outputs panel's own
  // hidden [role="tab"] list, which is unclickable and just times out.
  const TASK_TABS = [
    'details',
    'execution',
    'node-runs',
    'outputs',
    'artifacts',
    'worktree-diff',
    'worktree-files',
    'task-questions',
    'feedback',
  ]
  for (const tab of TASK_TABS) {
    await page.goto(`${daemon.baseUrl}/tasks/${seededTaskId}?tab=${tab}`)
    await expect(page.locator('.page--task-detail, .task-detail__panes').first()).toBeVisible()
    await page.waitForTimeout(350)
    record(`/tasks/{id}?tab=${tab}`, await sweep())
  }

  // Workgroup detail (the room's own page, distinct from the task chatroom pane).
  await page.goto(`${daemon.baseUrl}/workgroups/focus-ring-audit-wg`)
  await expect(page.locator('.app-shell, .page, main').first()).toBeVisible()
  await page.waitForTimeout(500)
  record('/workgroups/{name}', await sweep())

  // Review detail: .review-detail__layout carries `padding-right: 14px` only
  // (added for a different clip report), so left/top/bottom had zero room.
  if (seededReviewId) {
    await page.goto(`${daemon.baseUrl}/reviews/${seededReviewId}`)
    await expect(page.locator('.page--review-detail, .review-detail__layout').first()).toBeVisible()
    await page.waitForTimeout(700)
    record('/reviews/{id}', await sweep())
  }

  // Workgroup room (chatroom pane): member cards + run log rows. T4's
  // "focus ring 100% invisible" bug lived here and the geometry audit could
  // not see it until this fixture existed.
  if (seededWorkgroupTaskId) {
    await page.goto(`${daemon.baseUrl}/tasks/${seededWorkgroupTaskId}?tab=chatroom`)
    await expect(page.locator('.page--task-detail').first()).toBeVisible()
    await page.waitForTimeout(900)
    record('/tasks/{id}?tab=chatroom', await sweep())
  }

  // Secondary dialogs reachable from list pages. Each is a .dialog__body
  // scroll box holding form controls + buttons.
  const DIALOGS: Array<{ route: string; open: RegExp; label: string }> = [
    { route: '/workflows', open: /import yaml/i, label: '/workflows(import-dialog)' },
    { route: '/memory', open: /new memory/i, label: '/memory(new-dialog)' },
  ]
  for (const d of DIALOGS) {
    await page.goto(`${daemon.baseUrl}${d.route}`)
    await expect(page.locator('.app-shell, .page, main').first()).toBeVisible()
    const btn = page.getByRole('button', { name: d.open })
    expect(await btn.count(), `${d.label}: no trigger button matched ${d.open}`).toBeGreaterThan(0)
    await btn.first().click()
    await expect(page.locator('.dialog__panel').first()).toBeVisible()
    await page.waitForTimeout(400)
    record(d.label, await sweep())
    await page.keyboard.press('Escape')
  }

  // The originally reported repro: the batch-import dialog's textarea lost the
  // top 2px of its ring because `.dialog__body` only ever got a HORIZONTAL inset.
  await page.goto(`${daemon.baseUrl}/repos`)
  await page.getByRole('button', { name: /batch import/i }).click()
  await expect(page.locator('.dialog__panel')).toBeVisible()
  record('/repos(batch-import-dialog)', await sweep())

  // ── Narrow viewport (<=720px) ─────────────────────────────────────────
  // styles.css has a whole `@media (max-width: 720px)` regime that swaps
  // containers around — `.md-editor--fill` gains `overflow-y: auto` with no
  // padding, `.workgroup-room__side` flips to `overflow: visible`, the tasks
  // toolbar's `.segmented` becomes the scroll box itself (2px padding vs a 4px
  // ring), and `.page--split` grows a mobile back button. None of that is
  // exercised at the desktop viewport, so half the responsive CSS was
  // unaudited. Required by design.md §6 ("只测了默认视口" failure mode).
  await page.setViewportSize({ width: 720, height: 900 })
  for (const route of NARROW_ROUTES) {
    await page.goto(`${daemon.baseUrl}${route}`)
    await expect(page.locator('.app-shell, .page, main').first()).toBeVisible()
    await page.waitForTimeout(350)
    record(`${route}@720`, await sweep())
  }
  await page.goto(`${daemon.baseUrl}/tasks/${seededTaskId}`)
  await expect(page.locator('.page--task-detail').first()).toBeVisible()
  await page.waitForTimeout(500)
  record('/tasks/{id}@720', await sweep())
  await page.setViewportSize({ width: 1280, height: 800 })

  await cdp.detach()

  if (process.env.RFC206_DUMP_BASELINE) {
    // Regenerate the allowlist mechanically instead of hand-transcribing:
    //   RFC206_DUMP_BASELINE=1 npx playwright test e2e/focus-ring-clip.spec.ts --project=chromium
    const lines = [...seen].sort().map((k) => `  ['${k}', 'RFC-206 baseline'],`)
    console.log(`\n===RFC206_BASELINE_BEGIN===\n${lines.join('\n')}\n===RFC206_BASELINE_END===\n`)
  }

  // Coverage gate. Every fixture-backed surface below is reached through a
  // conditional (`if (seededReviewId)`, `if (!(await btn.count())) continue`),
  // so a fixture that stopped rendering would quietly contribute nothing and
  // the run would still say "0 clipped" — green for the wrong reason. Require
  // each one to have actually measured controls.
  const REQUIRED_SURFACES = [
    '/agents/{name}(tabs)',
    '/workflows/{id}(editor)',
    '/workflows/{id}(editor+inspector)',
    '/tasks/{id}',
    '/tasks/{id}?tab=outputs',
    '/reviews/{id}',
    '/tasks/{id}?tab=chatroom',
    '/repos(batch-import-dialog)',
    '/workflows(import-dialog)',
    '/memory(new-dialog)',
    '/agents@720',
    '/tasks/{id}@720',
  ]
  const uncovered = REQUIRED_SURFACES.filter((s) => (coverage.get(s) ?? 0) === 0)
  expect(
    uncovered,
    `these surfaces measured ZERO focusable controls — their fixture or navigation ` +
      `broke, so "no clips" here means "nothing was looked at":\n  ${uncovered.join('\n  ')}\n` +
      `\nCoverage actually observed:\n` +
      [...coverage].map(([k, n]) => `  ${k}: ${n}`).join('\n'),
  ).toEqual([])

  const byRoute = new Map<string, Violation[]>()
  for (const { route, v } of blocking) byRoute.set(route, [...(byRoute.get(route) ?? []), v])
  const report = [...byRoute]
    .map(([r, vs]) => `  ${r} — ${vs.length} clipped:\n${vs.map(describe).join('\n')}`)
    .join('\n')

  // Stale waivers absorb future regressions at the same spot, so they are a
  // failure too — checked here, where `seen` is guaranteed complete.
  const stale = [...KNOWN_CLIPS.keys()].filter((k) => !seen.has(k))

  expect(
    { clipped: blocking.length, staleWaivers: stale },
    blocking.length === 0 && stale.length === 0
      ? ''
      : `${blocking.length} clipped focus ring(s):\n${report}\n` +
          (stale.length
            ? `\nStale KNOWN_CLIPS entries (delete them):\n  ${stale.join('\n  ')}\n`
            : '') +
          `\n  Fix the container (give it >= var(--focus-ring-gutter) of padding) or make the\n` +
          `  control's ring inset (var(--focus-ring-offset-inset)). Only add a KNOWN_CLIPS\n` +
          `  entry if this is pre-existing and tracked by an RFC-206 batch.`,
  ).toEqual({ clipped: 0, staleWaivers: [] })
})
