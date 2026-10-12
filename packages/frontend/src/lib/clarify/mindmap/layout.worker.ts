import { layoutMindmap, type MindmapTopologyNode } from './layout'

self.onmessage = (
  event: MessageEvent<{ revision: string | number; rootId: string; nodes: MindmapTopologyNode[] }>,
) => {
  const { revision, rootId, nodes } = event.data
  try {
    self.postMessage({ revision, layout: layoutMindmap(nodes, rootId) })
  } catch (error) {
    self.postMessage({ revision, error: error instanceof Error ? error.message : String(error) })
  }
}
