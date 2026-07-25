# RFC-228 Agent 引用资源完整性与启动失败关闭 — proposal

状态：Done（2026-07-24；实现提交 `bf1b3e1a` 已推送 `main`）。

## 1. 问题

RFC-223 已把 Agent 对资源的持久引用改为 stable id。这个身份模型是正确的，但当前解析与校验
不完整：

1. Agent 编辑器的资源列表尚未加载、请求失败或资源已删除时，`MultiSelect` 会把 stable id
   直接当标签，用户看到的是内部标识而不是资源名称或明确状态。
2. Agent 保存只分散校验 MCP、Plugin 和依赖 Agent；missing managed Skill 可以保存，partial
   update 也不会重新检查最终 Agent 闭包。
3. Workflow validator 漏掉 Agent 的 MCP 引用；Workgroup 启动只检查成员 Agent 是否存在，
   不检查成员 Agent 的资源闭包。
4. 资源在保存后被异常删除时，scheduler 会跳过无法 hydrate 的 Skill/MCP/Plugin，让节点带着
   减少后的能力继续运行。

普通删除接口已有反向引用保护，但旧数据、恢复、手工改库和检查后的竞态仍可能留下悬空 id，
因此启动与运行时必须各有一道失败关闭门。

## 2. 目标

- stable id 继续作为持久身份；可见资源在 UI 显示名称。
- 不可解析的选中值显示类型化状态（正在解析、已删除、无权限或不可用），不显示 raw id。
- 一个权威检查覆盖根 Agent 及完整 `dependsOn` 闭包中的 managed Skill、MCP、Plugin 和
  dependency Agent。
- Agent create/update 校验合并后的最终闭包。
- Direct Agent、Workflow、Workgroup 和对应 schedule 在副作用前拒绝无效闭包。
- scheduler 在 runtime spawn 前比较 requested id 与 hydrated row，不能静默少注入资源。
- ACL-hidden-but-existing 不能被误判成 missing，也不能泄露名称。

## 3. 产品合同

### 3.1 展示

Agent 详情从 `GET /api/agents/:id/resource-status` 取得 actor-safe 标签：

- `available`：显示资源名称；
- `hidden`：显示类型化“无权限查看”占位，不显示名称；
- `missing`：显示类型化“已删除”占位；
- `unavailable`：仅对可见但按既有合同不可用的 Skill/Plugin 显示名称和状态；
- 状态与资源列表都还没返回时显示“正在解析”，不回退 raw id。

API 写入仍使用 id；展示数据不回灌 draft。

### 3.2 完整性

以下问题使 Agent 无效：

- `dependsOn` 指向不存在的 Agent，或闭包形成循环；
- managed Skill 行不存在，或当前 boot 不可用；
- MCP 行不存在；
- Plugin 行不存在，或按既有 Plugin 合同被禁用；
- 闭包内任一依赖 Agent 有上述问题。

两个既有边界保持不变：

- project Skill 是 repo-local 名称，没有全局 DB 行，不做本检查；
- disabled MCP 仍按 RFC-223 作为“存在但不注入”，不冒充 missing，也不新增行为变化。

### 3.3 保存与启动

- Agent create/update 对完整 candidate closure 校验；修复坏引用的更新仍可提交。
- Workflow static validation 增加 direct/closure MCP existence 检查，并继续阻止所有 canonical
  workflow 启动入口。
- Direct Agent 与 Workgroup POST launch 在 host workflow、workspace、task 和消息等副作用前
  执行完整性检查。
- Agent/Workgroup schedule 保存时检查；触发时仍进入原启动服务并重新检查。
- scheduler 在 runtime spawn 前对 Skill/MCP/Plugin 做 exact-set 检查；发现删除竞态时让 node
  明确失败。

前端的 disabled/banner 只是即时提示；状态请求失败时不伪装成资源缺失，最终 POST 仍由服务端
权威门禁决定。

## 4. 非目标

- 不把引用改回 name，不增加名称快照 migration。
- 不自动移除坏引用或恢复已删除资源。
- 不改变 ACL implicit-closure/grandfathering 规则。
- 不把 disabled MCP 改成错误。
- 不在没有 workspace 时判断 project Skill 是否存在。

## 5. 验收标准

- 可见引用显示名称；loading/hidden/missing/unavailable 均不显示 raw id。
- missing managed Skill 不能保存；sparse update 不能保留最终闭包中的坏引用。
- Workflow 能在静态校验阶段发现 direct/closure missing MCP。
- Workgroup 任一成员闭包无效时，启动在创建 host/task 前失败。
- runtime hydration 发现 missing Skill/MCP/Plugin 时失败，不以减少后的资源集执行。
- hidden existing ref 可继续执行且不泄露名称；project Skill 与 disabled MCP 合同不回归。
- backend/frontend 定向测试、typecheck、lint、format 与相关全量测试通过。

## 6. 兼容性

无数据库 migration。新增两个只读状态端点和 `agent-resources-invalid` 错误；Agent、Workflow、
Workgroup 的持久 schema 不变。行为只收紧真正 missing/unavailable 的引用和运行时 silent-drop。
