import type { GraphViewData } from './graphDesignModel'

type ElementIndex = GraphViewData['renderings'][number]['elementIndex']

export interface GraphModelNodeBinding {
  target: SVGElement
  elementId: string
  label: string
}

/** Match Mermaid's semantic containers, never an edge that names its endpoints. */
export function graphModelNodeBindings(
  container: HTMLElement,
  elementIndex: ElementIndex,
): GraphModelNodeBinding[] {
  const elements = new Map(elementIndex.map((item) => [item.renderId, item]))
  const bindings: GraphModelNodeBinding[] = []
  const bound = new Set<SVGElement>()
  const bind = (target: SVGElement, renderId: string | null) => {
    const item = renderId === null ? undefined : elements.get(renderId)
    if (!item || bound.has(target)) return
    bound.add(target)
    bindings.push({ target, elementId: item.elementId, label: item.label })
  }

  for (const target of container.querySelectorAll<SVGGElement>('g.node')) {
    // Mermaid 11 prefixes flowchart IDs with the enclosing SVG ID. State and
    // ER use the same node container with their own prefix and numeric counter.
    // Parse the whole ID: g123 must not match g1234, a note, or an edge label.
    const svgPrefix = `${target.ownerSVGElement?.id ?? ''}-`
    const localId = target.id.startsWith(svgPrefix) ? target.id.slice(svgPrefix.length) : target.id
    const match = /^(?:flowchart|state|entity)-(.+)-\d+$/.exec(localId)
    if (match) bind(target, match[1]!)
  }

  // Sequence lifelines carry the same data-id as their participant. Only the
  // participant group is interactive; its label remains inside that group.
  for (const target of container.querySelectorAll<SVGGElement>('g[data-et="participant"]'))
    bind(target, target.getAttribute('data-id'))

  // Mirrored participants omit data-id; the actor rectangle retains the exact
  // source name. Bind its containing group so both the rectangle and text work.
  for (const actor of container.querySelectorAll<SVGRectElement>('rect.actor-bottom[name]')) {
    const target = actor.parentNode
    if (target instanceof SVGElement && target.tagName.toLowerCase() === 'g')
      bind(target, actor.getAttribute('name'))
  }
  return bindings
}
