// e2e fixture 装载：YAML 工作流样例 → `POST /api/workflows`。
//
// 为什么需要它：RFC-271 批次 I 下线了 `POST /api/workflows/import`（裸 YAML 导入）
// 与 `GET /api/workflows/:id/export`。理由见 `rfc271-capability-removal.test.ts` 的
// 文件头——YAML 只序列化工作流自己的 `definition`，代理背后的技能 / MCP / 插件闭包
// 一个字节都不在文件里，导到另一个实例必然悬空。取代它的是配置包。
//
// 但**几个 e2e 只是拿那个端点当装载手段**（被测对象是工作流的执行语义，不是导入）。
// 给它们造一个 zip 走配置包是本末倒置，所以这里做最小的事：解析 YAML、把
// `agentName` 解析成本机 `agentId`、然后走**公开的** `POST /api/workflows`。
//
// ⚠️ 刻意**不**复用 backend 的 `importWorkflowYaml`：那会让 e2e 依赖一条产品上已经
// 不存在的路径，下次有人删掉它时 e2e 又会红在一个与被测行为无关的地方。走公开 API
// 意味着这些 fixture 装载与真实用户能做的事保持一致。

import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

interface AgentRow {
  id: string
  name: string
}

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>

/**
 * 读一个 `examples/workflows/**` 的 YAML 样例并建成工作流。
 *
 * `agentName` → `agentId`：YAML 里 agent 按**名字**引用（跨实例可移植的形态），
 * 而 `POST /api/workflows` 的 definition 要 canonical id。call 目标的
 * `workflowName` / `workgroupName` **保持名字**——那两个槽本来就是名字权威的
 * late-bound 引用，转成 id 反而不对。
 */
export async function loadWorkflowFixture<T>(apiFetch: ApiFetch, yamlPath: string): Promise<T> {
  const doc = parseYaml(readFileSync(yamlPath, 'utf-8')) as {
    name: string
    description?: string
    definition: { nodes?: unknown[] }
  }

  const agentsRes = await apiFetch('/api/agents')
  if (!agentsRes.ok) {
    throw new Error(`load fixture ${yamlPath}: GET /api/agents -> ${agentsRes.status}`)
  }
  const idByName = new Map<string, string>()
  for (const a of (await agentsRes.json()) as AgentRow[]) idByName.set(a.name, a.id)

  const definition = {
    ...doc.definition,
    nodes: (doc.definition.nodes ?? []).map((raw) => {
      const node = { ...(raw as Record<string, unknown>) }
      const agentName = node.agentName
      if (typeof agentName !== 'string' || agentName === '') return node
      const agentId = idByName.get(agentName)
      if (agentId === undefined) {
        // 说清楚缺的是哪个——「工作流建不出来」比「跑起来才发现节点没代理」难查得多。
        throw new Error(
          `load fixture ${yamlPath}: node '${String(node.id)}' references agent '${agentName}', which does not exist on this instance`,
        )
      }
      delete node.agentName
      return { ...node, agentId }
    }),
  }

  const res = await apiFetch('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: doc.name,
      description: doc.description ?? '',
      definition,
    }),
  })
  if (res.status !== 201) {
    throw new Error(
      `load fixture ${yamlPath}: POST /api/workflows -> ${res.status} ${await res.text()}`,
    )
  }
  return (await res.json()) as T
}
