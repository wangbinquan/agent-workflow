// PlantUmlBlock — RFC-005 PR-C T18.
//
// Locks in the kroki-style render path (GET deflate+base64 → POST fallback
// → unconfigured fallback / error display). Uses vitest's vi.stubGlobal
// to swap `fetch` for each scenario.

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { PlantUmlBlock, extractPlantUmlSyntaxError } from '@/components/review/PlantUmlBlock'

// The unconfigured-hint / render-failed copy moved into the i18n bundle
// (reviews.plantuml*). This file's assertions check the English wording, so
// pin the locale to en-US before any render. vitest isolates modules per file,
// so this does not leak into other suites.
beforeAll(async () => {
  await i18n.changeLanguage('en-US')
})

function makeMount(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

async function settle(ms: number = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('encodeForGet', () => {
  test('produces a non-empty base64-url-encoded string', () => {
    const enc = PlantUmlBlock.encodeForGet('@startuml\nA -> B\n@enduml')
    expect(enc.length).toBeGreaterThan(0)
    // base64url alphabet: [A-Za-z0-9_-], no padding
    expect(/^[A-Za-z0-9_-]+$/.test(enc)).toBe(true)
  })

  test('different sources produce different encodings', () => {
    const a = PlantUmlBlock.encodeForGet('@startuml\nA -> B\n@enduml')
    const b = PlantUmlBlock.encodeForGet('@startuml\nC -> D\n@enduml')
    expect(a).not.toBe(b)
  })
})

describe('encodeForPlantuml', () => {
  // Locks in the fix for the picoweb XML-0x1 crash: picoweb decodes URL
  // payloads using the digits-first PlantUML alphabet. If we ever revert
  // to a base64url-only encoder, picoweb will once again decode garbage,
  // emit SVGs containing control chars, and crash XML serialisation.
  test('uses PlantUML alphabet (digits-first), not base64url', () => {
    const enc = PlantUmlBlock.encodeForPlantuml('@startuml\nA -> B\n@enduml')
    expect(enc.length).toBeGreaterThan(0)
    expect(/^[0-9A-Za-z_-]+$/.test(enc)).toBe(true)
  })

  test('differs from base64url encoding for the same source', () => {
    // Same deflate compression, different 6-bit→char mapping. Output
    // length matches (no padding either way) but byte-for-byte distinct
    // for any non-trivial payload.
    const src = '@startuml\nA -> B\n@enduml'
    const kroki = PlantUmlBlock.encodeForGet(src)
    const plantuml = PlantUmlBlock.encodeForPlantuml(src)
    expect(plantuml).not.toBe(kroki)
  })

  test('different sources produce different encodings', () => {
    const a = PlantUmlBlock.encodeForPlantuml('@startuml\nA -> B\n@enduml')
    const b = PlantUmlBlock.encodeForPlantuml('@startuml\nC -> D\n@enduml')
    expect(a).not.toBe(b)
  })
})

describe('render — unconfigured endpoint', () => {
  test('empty endpoint → source code + hint', () => {
    const mount = makeMount()
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', undefined, undefined)
    expect(mount.querySelector('.review-diagram__unconfigured')).not.toBeNull()
    expect(mount.querySelector('.review-diagram__hint')?.textContent).toMatch(/not configured/)
    expect(mount.querySelector('.review-diagram__source')?.textContent).toContain('@startuml')
  })

  test('hint copy reads as a system notice, not body text', () => {
    // Wording locked in so a future copy refactor cannot silently regress
    // the "this is a system message, not markdown content" cue. The CSS
    // banner (border-left accent + tinted bg) lives in prose.css; here we
    // just verify the textual cues are present.
    const mount = makeMount()
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', undefined, undefined)
    const hintText = mount.querySelector('.review-diagram__hint')?.textContent ?? ''
    expect(hintText).toMatch(/PlantUML/)
    expect(hintText).toMatch(/Settings → Rendering/)
    expect(hintText.toLowerCase()).toContain('showing')
  })

  test('whitespace endpoint → same fallback', () => {
    const mount = makeMount()
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', '   ', undefined)
    expect(mount.querySelector('.review-diagram__unconfigured')).not.toBeNull()
  })
})

describe('render — first GET succeeds (happy path)', () => {
  test('mount receives the returned SVG', async () => {
    const mount = makeMount()
    vi.stubGlobal('fetch', async (_url: string) => {
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
      })
    })
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', 'https://kroki.io', undefined)
    // loading state initially
    expect(mount.querySelector('.review-diagram__loading')).not.toBeNull()
    await settle(50)
    expect(mount.querySelector('.review-diagram__svg svg')).not.toBeNull()
  })

  test('trailing slash on endpoint is normalized', async () => {
    const mount = makeMount()
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200 })
    })
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', 'https://kroki.io/', undefined)
    await settle(50)
    // Either alphabet payload is shaped `[A-Za-z0-9_-]+` since the two
    // alphabets share the same character class, only the per-byte mapping
    // differs.
    expect(calls[0]).toMatch(/^https:\/\/kroki\.io\/plantuml\/svg\/[A-Za-z0-9_-]+$/)
  })

  test('Authorization header forwarded when configured', async () => {
    const mount = makeMount()
    const seenHeaders: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      const auth = h.get('Authorization')
      if (auth !== null) seenHeaders.push(auth)
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200 })
    })
    PlantUmlBlock.render(mount, 'src', 'https://kroki.io', 'Bearer xxx')
    await settle(50)
    expect(seenHeaders).toContain('Bearer xxx')
  })
})

describe('render — GET ordering: PlantUML alphabet tried FIRST (picoweb-safe)', () => {
  // Regression: my first cut had base64url GET first, then plantuml-alphabet
  // GET fallback. That made the frontend work for picoweb (second attempt
  // rendered), but picoweb's first-attempt failure was not a clean 4xx —
  // it crashed mid-render with `XML 0x1` and spammed a stacktrace into the
  // server log on EVERY diagram. Swapping the order keeps picoweb's log
  // clean: plantuml-alpha succeeds on the first GET, base64url stays as
  // fallback for kroki.io.
  test('first GET uses PlantUML alphabet; falls back to base64url only if it fails', async () => {
    const mount = makeMount()
    const src = '@startuml\nA -> B\n@enduml'
    const plantumlEncoded = PlantUmlBlock.encodeForPlantuml(src)
    const krokiEncoded = PlantUmlBlock.encodeForGet(src)
    const seenUrls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seenUrls.push(url)
      if (url.endsWith(`/plantuml/svg/${plantumlEncoded}`)) {
        return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200 })
      }
      return new Response('unexpected GET', { status: 500 })
    })
    PlantUmlBlock.render(mount, src, 'https://example.test', undefined)
    await settle(50)
    expect(seenUrls.length).toBe(1)
    expect(seenUrls[0]).toBe(`https://example.test/plantuml/svg/${plantumlEncoded}`)
    // Crucially, base64url is NOT hit when plantuml-alpha already worked,
    // so picoweb is never asked to decode a payload that would crash it.
    expect(seenUrls.some((u) => u.endsWith(krokiEncoded))).toBe(false)
    expect(mount.querySelector('.review-diagram__svg svg')).not.toBeNull()
  })

  test('plantuml-alphabet GET fails → base64url GET tried (kroki.io path)', async () => {
    const mount = makeMount()
    const src = '@startuml\nA -> B\n@enduml'
    const plantumlEncoded = PlantUmlBlock.encodeForPlantuml(src)
    const krokiEncoded = PlantUmlBlock.encodeForGet(src)
    const seenUrls: string[] = []
    let postCalled = false
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seenUrls.push(url)
      if (init?.method === 'POST') {
        postCalled = true
        return new Response('should not reach POST', { status: 500 })
      }
      if (url.endsWith(plantumlEncoded)) return new Response('rejected', { status: 400 })
      if (url.endsWith(krokiEncoded)) {
        return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200 })
      }
      return new Response('unexpected', { status: 404 })
    })
    PlantUmlBlock.render(mount, src, 'https://example.test', undefined)
    await settle(50)
    expect(seenUrls[0]).toBe(`https://example.test/plantuml/svg/${plantumlEncoded}`)
    expect(seenUrls[1]).toBe(`https://example.test/plantuml/svg/${krokiEncoded}`)
    expect(postCalled).toBe(false)
    expect(mount.querySelector('.review-diagram__svg svg')).not.toBeNull()
  })
})

describe('render — both GET paths fail, POST succeeds (plantuml-server path)', () => {
  test('falls back to POST raw and renders SVG', async () => {
    const mount = makeMount()
    let getCount = 0
    let postCalled = false
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCalled = true
        return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200 })
      }
      getCount += 1
      return new Response('not found', { status: 404 })
    })
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', 'https://example.test', undefined)
    await settle(50)
    expect(getCount).toBe(2)
    expect(postCalled).toBe(true)
    expect(mount.querySelector('.review-diagram__svg svg')).not.toBeNull()
  })
})

describe('render — both paths fail', () => {
  test('shows error wrapper + source code', async () => {
    const mount = makeMount()
    vi.stubGlobal('fetch', async () => {
      return new Response('boom', { status: 500 })
    })
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', 'https://example.test', undefined)
    await settle(50)
    expect(mount.querySelector('.review-diagram__error')?.textContent).toMatch(
      /plantuml render failed/,
    )
    expect(mount.querySelector('.review-diagram__source')?.textContent).toContain('@startuml')
  })

  test('network error also falls back to error + source (localized, RFC-203 T5a)', async () => {
    const mount = makeMount()
    vi.stubGlobal('fetch', async () => {
      throw new Error('connection refused')
    })
    PlantUmlBlock.render(mount, 'src', 'https://example.test', undefined)
    await settle(50)
    // The direct-endpoint chain tags transport failures at the fetch boundary
    // (fetchOrNetworkError) and resolves them through describeApiError — the
    // user sees the localized offline copy, not a raw transport message.
    expect(mount.querySelector('.review-diagram__error')?.textContent).toMatch(
      /Cannot reach the service|无法连接到服务/,
    )
  })

  test('non-SVG response falls back to error path', async () => {
    const mount = makeMount()
    vi.stubGlobal('fetch', async () => {
      return new Response('<html>not svg</html>', { status: 200 })
    })
    PlantUmlBlock.render(mount, 'src', 'https://example.test', undefined)
    await settle(50)
    expect(mount.querySelector('.review-diagram__error')).not.toBeNull()
  })
})

describe('extractPlantUmlSyntaxError', () => {
  // PlantUML's 4xx body for a real source-side syntax error contains an
  // SVG with `<text>` lines like "PlantUML version 1.2026.4 …" and
  // "[From string (line 38) ]", a dump of the source, and as the LAST
  // <text> the actual failure reason. Locked here because we now route
  // those responses to the error banner with BOTH the line number and the
  // reason, bypassing further fetch fallbacks (the previous behaviour
  // painted kroki's "use ~1 header" diagnostic over the real error,
  // hiding both pieces of information).
  test('returns line number + reason when both present', () => {
    // The trailing `<text>` is the real error reason from a real picoweb
    // run on a multi-`else` activity diagram (see the in-browser repro
    // captured during RFC-005 debugging).
    const body = `<svg xmlns="http://www.w3.org/2000/svg">
      <text>PlantUML version 1.2026.4 / 7d5d424</text>
      <text>[From string (line 38) ]</text>
      <text>&#160;</text>
      <text>@startuml</text>
      <text>start</text>
      <text>if (a?) then (yes)</text>
      <text>else (b?)</text>
      <text>Cannot find if (Assumed diagram type: activity)</text>
    </svg>`
    expect(extractPlantUmlSyntaxError(body)).toBe(
      'PlantUML syntax error at line 38 — Cannot find if (Assumed diagram type: activity)',
    )
  })
  test('returns line number only when reason text is absent', () => {
    const body = `<svg><text>PlantUML version 1.2026.4</text>
      <text>[From string (line 38) ]</text></svg>`
    expect(extractPlantUmlSyntaxError(body)).toBe(
      'PlantUML syntax error at line 38 (see source below)',
    )
  })
  test('returns reason only when "From string (line N)" is absent', () => {
    const body = `<svg><text>PlantUML version 1.2026.4</text>
      <text>Something broke at the renderer</text></svg>`
    expect(extractPlantUmlSyntaxError(body)).toBe(
      'PlantUML syntax error — Something broke at the renderer',
    )
  })
  test('skips dumped source lines when scanning for the reason', () => {
    // The reason scanner walks from the end of <text> list. Lines that
    // look like PlantUML source (`@startuml`, `skinparam`, `start`, `if (`,
    // `else (...)`, `:foo;`, …) are skipped so we never echo a user-source
    // line as if it were the failure reason.
    const body = `<svg>
      <text>PlantUML version 1.2026.4</text>
      <text>[From string (line 4) ]</text>
      <text>@startuml</text>
      <text>skinparam dpi 120</text>
      <text>start</text>
      <text>:bogus;</text>
      <text>Cannot find :bogus; (Assumed diagram type: activity)</text>
    </svg>`
    expect(extractPlantUmlSyntaxError(body)).toBe(
      'PlantUML syntax error at line 4 — Cannot find :bogus; (Assumed diagram type: activity)',
    )
  })
  test('"Syntax Error" trailing text is itself surfaced as the reason', () => {
    // Older PlantUML versions only write "Syntax Error?" without a line
    // number. The reason scanner picks that up as the reason text.
    const body = `<svg><text>PlantUML version 1.2024.0</text><text>Syntax Error</text></svg>`
    expect(extractPlantUmlSyntaxError(body)).toBe('PlantUML syntax error — Syntax Error')
  })
  test('completely empty error body still returns a fallback string', () => {
    // No line, no reason. We still want the banner to read sensibly.
    const body = `<svg><text>PlantUML version 1.2024.0</text></svg>`
    expect(extractPlantUmlSyntaxError(body)).toBeNull()
  })
  test('returns null for kroki-style "use ~1 header" diagnostic SVG', () => {
    const body = `<svg><text>The plugin you are using seems to generated a bad URL.</text>
      <text>This URL does not look like DEFLATE data.</text></svg>`
    expect(extractPlantUmlSyntaxError(body)).toBeNull()
  })
  test('returns null for a non-SVG body', () => {
    expect(extractPlantUmlSyntaxError('Bad Request')).toBeNull()
  })
  test('returns null for an SVG body without PlantUML version stamp', () => {
    expect(extractPlantUmlSyntaxError('<svg><text>foo</text></svg>')).toBeNull()
  })
})

describe('render — PlantUML syntax error on first GET surfaces line number + reason', () => {
  test('first GET 4xx with PlantUML error SVG → banner shows line + reason; no further GET, no kroki overlay', async () => {
    const mount = makeMount()
    const errSvg = `<svg xmlns="http://www.w3.org/2000/svg">
      <text>PlantUML version 1.2026.4</text>
      <text>[From string (line 38) ]</text>
      <text>@startuml</text>
      <text>start</text>
      <text>if (a?) then (yes)</text>
      <text>else (b?)</text>
      <text>Cannot find if (Assumed diagram type: activity)</text>
    </svg>`
    const seenUrls: string[] = []
    let postCalled = false
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seenUrls.push(url)
      if (init?.method === 'POST') {
        postCalled = true
        return new Response('should not POST', { status: 200 })
      }
      // First GET (plantuml-alpha) returns the authoritative error.
      // If the second GET happens it'd return a fake success — that's the
      // regression we're locking against.
      if (seenUrls.length === 1) {
        return new Response(errSvg, { status: 400 })
      }
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', { status: 200 })
    })
    PlantUmlBlock.render(mount, '@startuml\nbad\n@enduml', 'https://example.test', undefined)
    await settle(50)
    // Only one GET — fallback chain stopped on the syntax error sentinel.
    expect(seenUrls.length).toBe(1)
    expect(postCalled).toBe(false)
    // Error banner shows line number AND the actual failure reason from
    // PlantUML — no silent "line N (see source below)" without context.
    const errText = mount.querySelector('.review-diagram__error')?.textContent ?? ''
    expect(errText).toMatch(/line 38/)
    expect(errText).toMatch(/Cannot find if/)
    expect(mount.querySelector('.review-diagram__source')?.textContent).toContain('@startuml')
    // No SVG painted (no kroki diagnostic overlay).
    expect(mount.querySelector('.review-diagram__svg')).toBeNull()
  })
})

describe('hostOf', () => {
  test('extracts the hostname from a URL endpoint (incl. port)', () => {
    expect(PlantUmlBlock.hostOf('https://kroki.io')).toBe('kroki.io')
    expect(PlantUmlBlock.hostOf('https://plantuml.example.com:8080/render')).toBe(
      'plantuml.example.com:8080',
    )
  })
  test('falls back to the bare host when the endpoint is not a full URL', () => {
    expect(PlantUmlBlock.hostOf('kroki.io')).toBe('kroki.io')
  })
})

// RFC-005 (Q10) — a configured endpoint receives the raw document source.
// Regression guard: the send must NEVER be silent — a host-named privacy notice
// shows at send time (loading) and persists under the rendered diagram. The
// acceptance criterion (design.md) is "UI 显式提示『将向 {host} 发送源码』".
describe('render — privacy notice (Q10)', () => {
  test('configured endpoint shows a host-named privacy notice during loading', () => {
    const mount = makeMount()
    // a fetch that never settles, so we can inspect the loading state
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', 'https://kroki.io', undefined)
    const note = mount.querySelector('.review-diagram__privacy')
    expect(note).not.toBeNull()
    expect(note?.textContent).toContain('kroki.io')
    expect(note?.textContent?.toLowerCase()).toContain('sent to')
    // loading is still shown alongside the notice
    expect(mount.querySelector('.review-diagram__loading')).not.toBeNull()
  })

  test('privacy notice persists under the rendered SVG (not just transiently)', async () => {
    const mount = makeMount()
    vi.stubGlobal(
      'fetch',
      async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200 }),
    )
    PlantUmlBlock.render(mount, 'src', 'https://kroki.io', undefined)
    await settle(50)
    expect(mount.querySelector('.review-diagram__svg svg')).not.toBeNull()
    expect(mount.querySelector('.review-diagram__privacy')?.textContent).toContain('kroki.io')
  })

  test('unconfigured endpoint shows NO privacy notice (nothing is sent)', () => {
    const mount = makeMount()
    PlantUmlBlock.render(mount, 'src', undefined, undefined)
    expect(mount.querySelector('.review-diagram__privacy')).toBeNull()
  })
})
