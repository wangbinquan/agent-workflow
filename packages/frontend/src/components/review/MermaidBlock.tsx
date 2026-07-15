// MermaidBlock — RFC-005 PR-C T17.
//
// Renders ```mermaid fenced blocks. mermaid is a ~3 MB dependency at the
// time of writing, so we lazy-load it the first time a diagram appears in
// the rendered markdown. The component is a static helper, not a React
// component — see MarkdownView for why we mount diagrams as DOM-side
// attachments (one React tree for the whole document, not per diagram).
//
// NOTE: we intentionally do not run an extra DOMPurify pass on the SVG
// mermaid returns. mermaid flowcharts emit node labels as <foreignObject>
// wrapping XHTML, and no DOMPurify configuration we tested (svg profile,
// html profile, ADD_TAGS: ['foreignObject'], PARSER_MEDIA_TYPE xhtml) can
// preserve the foreignObject children through the SVG↔HTML namespace
// transition — the labels come out blank. mermaid.initialize already
// applies its own DOMPurify in `securityLevel: 'strict'` mode (text-level
// `<script>` is encoded, click handlers disabled), so this is the
// defensive layer; an outer pass was double-sanitizing and breaking
// labels (see the prose-code-mermaid-labels regression test).

import type * as MermaidNS from 'mermaid'

type Mermaid = (typeof MermaidNS)['default']
export type MermaidTheme = 'light' | 'dark'

let mermaidPromise: Promise<Mermaid> | null = null

// Custom mermaid palettes keyed to the app's CSS variables (see
// styles.css :root / [data-theme=dark]). We use theme: 'base' + explicit
// themeVariables rather than mermaid's stock 'default' / 'dark' so diagrams
// read like part of the UI instead of an unstyled screenshot. The light
// preset mirrors --panel / --text / --accent / --border at light values
// and the dark preset at dark values, with `darkMode: true` flipping
// mermaid's internal defaults for any variable we don't explicitly set.
const THEME_VARS: Record<MermaidTheme, Record<string, string>> = {
  light: {
    background: '#ffffff',
    primaryColor: '#ffffff',
    primaryTextColor: '#1f2328',
    primaryBorderColor: '#1f5fda',
    secondaryColor: '#eef3ff',
    secondaryTextColor: '#1f2328',
    secondaryBorderColor: '#1f5fda',
    tertiaryColor: '#f8f9fb',
    tertiaryTextColor: '#1f2328',
    tertiaryBorderColor: '#e3e5ea',
    lineColor: '#5b6271',
    textColor: '#1f2328',
    mainBkg: '#ffffff',
    nodeBorder: '#1f5fda',
    clusterBkg: '#f8f9fb',
    clusterBorder: '#e3e5ea',
    defaultLinkColor: '#5b6271',
    edgeLabelBackground: '#ffffff',
    actorBkg: '#ffffff',
    actorBorder: '#1f5fda',
    actorTextColor: '#1f2328',
    actorLineColor: '#5b6271',
    signalColor: '#1f2328',
    signalTextColor: '#1f2328',
    labelBoxBkgColor: '#eef3ff',
    labelBoxBorderColor: '#1f5fda',
    labelTextColor: '#1f2328',
    loopTextColor: '#1f2328',
    noteBkgColor: '#fff8d6',
    noteBorderColor: '#844700',
    noteTextColor: '#1f2328',
  },
  dark: {
    darkMode: 'true',
    background: '#15181d',
    primaryColor: '#1c2028',
    primaryTextColor: '#e6e7ea',
    primaryBorderColor: '#8eb8ff',
    secondaryColor: '#222a38',
    secondaryTextColor: '#e6e7ea',
    secondaryBorderColor: '#8eb8ff',
    tertiaryColor: '#1c2028',
    tertiaryTextColor: '#e6e7ea',
    tertiaryBorderColor: '#2a2f38',
    lineColor: '#95a0b3',
    textColor: '#e6e7ea',
    mainBkg: '#1c2028',
    nodeBorder: '#8eb8ff',
    clusterBkg: '#15181d',
    clusterBorder: '#2a2f38',
    defaultLinkColor: '#95a0b3',
    edgeLabelBackground: '#1c2028',
    actorBkg: '#1c2028',
    actorBorder: '#8eb8ff',
    actorTextColor: '#e6e7ea',
    actorLineColor: '#95a0b3',
    signalColor: '#e6e7ea',
    signalTextColor: '#e6e7ea',
    labelBoxBkgColor: '#222a38',
    labelBoxBorderColor: '#8eb8ff',
    labelTextColor: '#e6e7ea',
    loopTextColor: '#e6e7ea',
    noteBkgColor: '#3a2f10',
    noteBorderColor: '#ffc25c',
    noteTextColor: '#e6e7ea',
  },
}

async function loadMermaid(theme: MermaidTheme): Promise<Mermaid> {
  if (mermaidPromise === null) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  const mermaid = await mermaidPromise
  // initialize is idempotent and the only way to flip the baked-in palette
  // (mermaid renders colors into the SVG, no CSS-variable hook). Call it
  // before every render so light↔dark theme flips re-color subsequent
  // diagrams.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: THEME_VARS[theme],
  })
  return mermaid
}

function isMermaidAvailable(): boolean {
  // We can't synchronously check whether `mermaid` is installed in tests
  // running under happy-dom; treat the lazy import as available unless
  // explicitly turned off (no env switch yet).
  return true
}

export const MermaidBlock = {
  /**
   * Async render. Resolves when the SVG is in place (or an error message
   * if rendering failed). Caller hands us the mount element + the diagram
   * source.
   */
  async render(mount: HTMLElement, source: string, theme: MermaidTheme = 'light'): Promise<void> {
    if (!isMermaidAvailable()) {
      mount.innerHTML =
        '<pre class="review-diagram__source"><code>' + escapeHtml(source) + '</code></pre>'
      return
    }
    try {
      const mermaid = await loadMermaid(theme)
      const id = 'mermaid-' + Math.random().toString(36).slice(2, 10)
      const { svg } = await mermaid.render(id, source)
      mount.innerHTML = svg
    } catch (err) {
      mount.innerHTML =
        `<div class="review-diagram__error">${escapeHtml((err as Error).message)}</div>` +
        `<pre class="review-diagram__source"><code>${escapeHtml(source)}</code></pre>`
    }
  },
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
