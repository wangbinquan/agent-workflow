# RFC-228 Agent 引用资源完整性与启动失败关闭 — design

状态：Done（2026-07-24）。

## 1. 权威检查

新增 `packages/backend/src/services/agentResourceIntegrity.ts`。

内部 inventory 一次加载：

- 全部 Agent；
- Skill raw rows（包含 list API 会隐藏的 reserving/quarantined row）；
- 全部 MCP；
- 全部 Plugin。

`evaluateAgentResourceIntegrity(inventory, rootAgentIds)` 是纯函数。它以 stable id 遍历每个 root
的 `dependsOn` 闭包，产生固定排序、去重后的 issue：

```ts
type AgentResourceIssueCode =
  | 'agent-dependency-not-found'
  | 'agent-dependency-cycle'
  | 'skill-not-found'
  | 'skill-unavailable'
  | 'mcp-not-found'
  | 'plugin-not-found'
  | 'plugin-disabled'
```

issue 记录 root、实际持有引用的 Agent、资源类型/id 与 dependency path。内部判定使用完整
inventory，不用 ACL-filtered list 推断“是否存在”。

`assertAgentResourceIntegrity` 对外只返回 code、kind、root 和 direct 标志，不在通用 launch
错误里回显闭包资源 id/name。

## 2. Actor-safe 状态

`getAgentResourceStatus(db, actor, root)` 先计算完整闭包，再对 Agent/Skill/MCP/Plugin 批量执行
既有 `filterVisibleRows`：

- row 不存在 → `missing`；
- row 存在但不可见 → `hidden`，name 为 null；
- Skill/Plugin 存在但按既有合同不可用 → `unavailable`；
- 其余 → `available`，可见时返回 name。

端点：

- `GET /api/agents/:id/resource-status`：direct refs + closure issues；
- `GET /api/workgroups/:id/resource-status`：成员 root 的脱敏 issue 摘要。

资源状态 GET 是 advisory。网络失败不等于 missing，也不取消 POST launch 的最终检查。

## 3. Agent 写入

`createAgent` 在现有 id/ACL/per-kind 校验后构造完整 candidate Agent，并以 override 放入 inventory；
`updateAgent` 把 sparse patch 与当前 Agent 合并后做同一检查。因此：

- missing managed Skill 首次进入 save-time gate；
- 未修改 refs 的 partial update 也不能保存仍有 dangling ref 的最终状态；
- 删除或替换坏引用后 candidate 可通过；
- project Skill 不进入 DB existence 检查。

现有事务内新引用 ACL/existence fence保持不变。普通删除仍由反向引用 guard 阻止；若检查后发生
异常删除，后面的 launch/runtime gate负责失败关闭。

## 4. Workflow

`loadWorkflowValidationContext` 增加 MCP inventory，并把 MCP projection 纳入 context hash。
`validateWorkflowDef` 对直接 Agent 与 dependsOn closure 检查每个 `mcp[]` id：

- inventory 中没有 → `mcp-not-found`；
- present-but-disabled → 有效，保持 RFC-223 的不注入语义。

`assertWorkflowLaunchable` 运行 canonical static validator，保证 schedule/save 等只调用该 helper
的入口也不会绕过资源检查。主 task launch 继续使用同一 validator/context。

## 5. Direct、Workgroup 与 Schedule

| 边界               | 接线                                                     |
| ------------------ | -------------------------------------------------------- |
| Direct Agent       | `startAgentTask` 重读 Agent 后、host/workspace/task 前   |
| Workgroup          | roster readiness 后、host snapshot/task/message 前       |
| Agent schedule     | target 保存检查 + 实际 fire 的 Direct gate               |
| Workgroup schedule | 全部 member roots 保存检查 + 实际 fire 的 Workgroup gate |
| Workflow schedule  | canonical static validation + 实际 fire 的 Workflow gate |

Workgroup UI 查询 member closure status；已知 invalid 时禁用 Launch 并显示错误。状态请求失败或
加载中不做误判，服务端 POST 仍会拒绝真正的 invalid closure。

## 6. Runtime race fence

`prepareNodeRunInjection` 在构造 RuntimeDriver plan 前：

1. 解析 Agent dependency closure；
2. 收集 requested managed Skill/MCP/Plugin ids；
3. 调用现有 batch loaders；
4. 比较 requested id set 与 hydrated id set；
5. 缺任一行则返回 `skill-not-found`、`mcp-not-found` 或 `plugin-not-found`。

Plugin disabled 和 Skill boot availability 保留原有失败合同；disabled MCP 仍可被 loader 返回，
随后由既有 runtime config builder过滤。

低层 loader 可继续返回部分 rows 以兼容其他只读调用方，但 runtime 调用者不得把 shorter result
当作允许降级执行。

## 7. 前端

`ResourcePicker` 与 `SkillsPicker` 始终为每个 selected token合成 option：

1. 可见 list row label；
2. resource-status 提供的 actor-safe label；
3. 类型化“正在解析”fallback。

因此 `MultiSelect` 的 raw-value fallback不会在资源 picker 中触发。Agent Resources tab显示
closure issues 和 danger badge；详情 Launch仅在服务端明确返回 `ok:false` 时禁用。

Workgroup详情同理：明确 invalid 才禁用并显示成员资源错误；请求失败由最终 POST gate兜底。

## 8. 测试

- Agent create：missing managed Skill 拒绝，project Skill 通过；
- Agent closure：依赖 Agent 的 missing Skill 阻止 root 保存；
- status：visible name、hidden mask、missing state；
- Workflow validator：direct/closure missing MCP，disabled MCP 不回归；
- Workgroup/Workflow launch：MCP 删除后失败，且 Workgroup host未创建；
- scheduler：Skill/MCP/Plugin 删除竞态在 spawn 前失败；
- ResourcePicker：加载中和 status overlay都不渲染 raw id；
- 既有 RFC-223 disabled-MCP 注入身份测试保持通过。
