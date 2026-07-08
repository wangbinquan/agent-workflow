# RFC-146 · 节点 kind 知识收口（plan）

> 依赖：T1 → T2（独立于 T3/T4）；T3、T4 依赖 T1、彼此独立。
> 授权语境：G3-G10 批量授权，设计门后直接实现。

## 任务分解

### RFC-146-T1 行为表重铸 + 谓词/集合收敛（后端+shared）

- 删四愿望维（表头注释接管语义说明）；增 `isProcess` / `isAgent` / `settlesWithoutRow`；
  `isProcessNodeKind` 改查表、新增 `isAgentNodeKind` 导出。
- 接线：SETTLES_WITHOUT_ROW_KINDS 派生化、inventory/sessionView 双 Set + isAgentRunKind
  删除、前端两谓词改 import、stuckTaskDetector（D7 优先谓词化）、runTask 白名单正向化、
  runOneNode fall-through 守卫。
- 测试：行为表重写 + 谓词 grep 守卫 + 白名单/守卫单测 + 受影响锁更新
  （fanout-routing 文本锁 / scheduler.test:206 / gap5 头注 / cross-clarify-shared 行断言）。
- **commit PR-1**：`feat(scheduler): RFC-146 PR-1 行为表重铸——全真维 + 谓词五处收敛`。

### RFC-146-T2 端口声明层单源（shared+双端）

- 新建 `shared/nodePorts.ts`：`declaredPorts` + `Record<NodeKind, deriver>` satisfies +
  data/system 分组 + per-port kind；新 shared 测试逐 kind 锁。
- 切换五消费面：validator 删第五 fork 改查表（系统口投影）；canvas computePorts 薄封装
  （边容错/有序化留前端，行为字节不变）；loop 候选 / 控制流 / 拖放改查声明层。
- 测试：canvas.test / fanout-port / control-flow / dropTarget / wrapper-candidates /
  validator 规则群全绿（等价性证明）。
- **commit PR-2**：`feat(workflow): RFC-146 PR-2 端口声明层单源——五 fork 收敛`。

### RFC-146-T3 NodeInspector 拆分注册表（前端）

- 8 个 per-kind 组件 + `KIND_INSPECTORS satisfies Record<NodeKind, FC<EditProps>>`；
  titleField 公共化；NODE_TYPES 补 satisfies。
- 测试：node-inspector 渲染群零改动全绿；tabs-retrofit-grep 验证不受影响。
- **commit PR-3**：`refactor(frontend): RFC-146 PR-3 NodeInspector per-kind 注册表化`。

### RFC-146-T4 palette 描述符表 + nodeTitle 单源（前端）

- `Record<NodeKind, PaletteDescriptor>`（section/labelKey/descKey/idPrefix/glyph/
  makeDefaults）替换 5 散装点；glyph 从各 *Node.tsx 收编。
- `nodeDisplayTitle` 单源（完整规则含 review:<port>）；canvas-node-title 更新。
- 测试：palette 全批 + icon-coverage 字面量锁全绿；标题格更新。
- **commit PR-4**：`refactor(frontend): RFC-146 PR-4 palette 描述符表 + nodeTitle 单源`。

## 门禁节奏

每 commit：typecheck×3 + lint + format + 定向套件；PR-2/PR-4 后各跑一次全量（backend+
frontend）+ binary smoke；全部推送后 CI conclusion 直查 + Codex 实现门（--base 覆盖全部
commit）循环至收敛。

## 验收清单

- [ ] 行为表每维有运行时消费者；四愿望维删除；谓词 5+2+1 处清零（grep 守卫）
- [ ] declaredPorts 单源、五消费面切换、canvas/validator 契约测试全绿
- [ ] runTask 白名单正向化 + runOneNode 守卫
- [ ] KIND_INSPECTORS / PALETTE / NODE_TYPES 三注册表 satisfies 穷举
- [ ] nodeTitle 单源（review:<port> 展示变化显式落测试）
- [ ] 新增 kind 改动面 = 4 个编译强制点 + 1 个运行时守卫（proposal §3 声明）
- [ ] 门禁 + CI conclusion + Codex 双门
