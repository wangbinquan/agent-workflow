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
      const v = (parseFloat(cs.outlineWidth) || 0) + (parseFloat(cs.outlineOffset) || 0);
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
        if (room[s] < 0) continue;
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
      return el ? auditOne(el) : [];
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
      measure(i: number): Violation[]
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
async function auditPage(page: Page, cdp: CDPSession): Promise<Violation[]> {
  await page.evaluate(AUDIT_ENGINE)
  const count = await page.evaluate(() => window.__frAudit.tag())

  // nodeIds are invalidated by navigation — always re-root per page.
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const found: Violation[] = []

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
    found.push(...((await page.evaluate((n) => window.__frAudit.measure(n), i)) as Violation[]))
    // Clearing is mandatory: forced state is per-node and persistent, so
    // leaving it on pollutes later measurements (e.g. an ancestor that would
    // then match :focus-within).
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
  }

  await page.evaluate(() => window.__frAudit.untag())
  return found
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
    const found = await auditPage(page, cdp)
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
    const found = await auditPage(page, cdp)
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
    const found = await auditPage(page, cdp)
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

  const record = (route: string, found: Violation[]) => {
    for (const { key, v } of keyed(route, found)) {
      seen.add(key)
      if (!KNOWN_CLIPS.has(key)) blocking.push({ route, v })
    }
  }

  const sweep = async (): Promise<Violation[]> => {
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

  // The originally reported repro: the batch-import dialog's textarea lost the
  // top 2px of its ring because `.dialog__body` only ever got a HORIZONTAL inset.
  await page.goto(`${daemon.baseUrl}/repos`)
  await page.getByRole('button', { name: /batch import/i }).click()
  await expect(page.locator('.dialog__panel')).toBeVisible()
  record('/repos(batch-import-dialog)', await sweep())

  await cdp.detach()

  if (process.env.RFC206_DUMP_BASELINE) {
    // Regenerate the allowlist mechanically instead of hand-transcribing:
    //   RFC206_DUMP_BASELINE=1 npx playwright test e2e/focus-ring-clip.spec.ts --project=chromium
    const lines = [...seen].sort().map((k) => `  ['${k}', 'RFC-206 baseline'],`)
    console.log(`\n===RFC206_BASELINE_BEGIN===\n${lines.join('\n')}\n===RFC206_BASELINE_END===\n`)
  }

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
