import { layoutMindmap, type MindmapTopologyNode } from './layout'

self.onmessage = (
  event: MessageEvent<{
    revision: string | number
    rootId: string
    nodes: MindmapTopologyNode[]
    columns?: number
  }>,
) => {
  const { revision, rootId, nodes, columns } = event.data
  try {
    self.postMessage({ revision, layout: layoutMindmap(nodes, rootId, columns) })
  } catch (error) {
    self.postMessage({ revision, error: error instanceof Error ? error.message : String(error) })
  }
}
