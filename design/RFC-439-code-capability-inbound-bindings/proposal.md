# RFC-439 代码能力的两个 HTTP 绑定归入 code-capability 模块（RFC-294 W4 B / D 第五步，E8 前置）

- **状态**：In Progress（2026-11-04）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D 与 E8
- **前序**：[RFC-438](../RFC-438-scheduled-tasks-into-integration/proposal.md)（定时任务归入 integration）
- **落位**：code-capability（E8 兼容岛）的 `inbound/http` 与 `composition/routes.ts`；`server.ts` 只改 import。

## 1. 背景

RFC-438 之后，`routes/` 里只剩两个文件深引模块内部，都属于 code-capability 兼容岛：

- `routes/code.ts`（`/api/code/*` 七个只读端点）：深引 `application/templateUpstreamStatus`（类型）与 `domain/stageContract`、
  `domain/capabilityRegistry`、`domain/stageGraph`；
- `routes/capabilityTemplates.ts`（`/api/capability-templates*` 八个端点加 ACL 端点）：深引 `application/capabilityTemplateOperations`
  与 `application/templateUpstreamStatus`（均为类型）。

两者都不 import `services/`，只依赖本模块与 HTTP 传输工具，在账本里是 6 条 `R1-inbound-module-internals`。`code.ts` 为避开 R1，
还把历史查询合同复制了一份结构副本（投递链的行写成 `unknown[]`）。

E8 的终局是把能力模板写入与历史查询并入 development-automation，然后删除兼容岛。这一步现在做不了，原因有三：
development-automation 被 RFC-310 T7 锁禁止消费 code-capability；岛内 domain 引用规范 schema；兼容岛还拥有表与转换探针，
约 69 个用例引用它。

## 2. 目标

- **G1 绑定归入模块**：两个路由迁入 `code-capability/inbound/http`（`codeRoutes.ts`、`capabilityTemplateRoutes.ts`），原文件删除，不留 facade；
  挂载经新增的 `composition/routes.ts` 转出，`server.ts` 经 composition 挂载。
- **G2 绑定只依赖本模块与传输工具**：
  - 本模块内用相对路径；
  - 历史查询合同改用本模块 application 的真实类型（投递链为 `CodeDeliveryChainQuery`），删去为避开 R1 而复制的结构副本。
- **G3 行为不变**：路由、方法、权限点、令牌访问、请求解析、响应字节、错误码与挂载顺序全部不变。
- **G4 守卫语料跟着走**：
  - RFC-317 ACL 写门守卫的语料扩到各模块 `inbound/` 下的 HTTP 绑定（RFC-436～438 搬走的绑定一并回到语料内），能力模板的精确委托锁改指新位置；
  - RFC-349 provider 边界守卫改扫模块的 `inbound/`。

## 3. 非目标

- E8 的整体吸收：能力模板写入与历史查询并入 development-automation、表归属与转换探针迁移、删除兼容岛。另立 RFC。
- `services/demoSeed.ts` 指向 `code-capability/composition/demoSeed` 的 R1 边（跨 context 的演示种子编排，随 E8 或种子收口处理）。
- `routes/registry`、`routes/resourceAcl` 等 HTTP 传输工具归位到 platform。
- 顺带订正 RFC-438 文档里与实现不符的一句描述（见 §6 第 4 条），不涉及代码。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`routes/code.ts`、`routes/capabilityTemplates.ts` 不再存在。新绑定不 import `services/`、`@/db`、他域与本模块 `infrastructure`。
  `composition.ts` 保持 schema-only（RFC-395 非运行时角色指纹不变）。
- **AC-2**：账本按实测更新：`R1-inbound-module-internals` 176 → 170；深引模块内部的路由 2 → 0；import `services/` 的路由仍为 23。
  其余结构门不回退，不新增 DAG 外的边。
- **AC-3**：`/api/code/*` 与 `/api/capability-templates*` 的用例全部通过，包括 PostgreSQL 历史查询、模板上游、ACL 端点矩阵与 RFC-317 写门守卫。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **先把绑定归入岛内，再整体吸收**：
   - 如果绑定直接进 development-automation，就得先搬 domain（stage 合同、注册表、图投影）与表归属，等于提前做完 E8；
   - 先让兼容岛自洽，入站适配器都在模块内、模块外不再有深引，E8 吸收时整个模块成块迁移。
2. **ACL 端点仍用通用挂载器 `mountAclEndpoints`**：
   - 它是 HTTP 传输模板，与 `registerRoute` 同类；
   - RFC-317 守卫锁定「四个 ACL 方法原样委托同一个 owner」这一精确形状，保留调用形状，这把锁才继续有效；
   - 改成注入挂载器（数字员工的做法）会让这把锁失去对象，收益只是少一条传输工具 import。
3. **新增 `composition/routes.ts`，不改 `composition.ts`**：后者是 RFC-395 登记的 schema-only 非运行时文件（带内容指纹），加转出会改变它的角色；
   与 intent 的 `composition/routes.ts` 同一形状。
4. **订正 RFC-438 文档**：RFC-438 的 proposal、design、plan、RFC 索引与 `STATE.md` 有一句写着「定时启动合同经 task-execution public 导出」，与实现不符。
   实际是 integration 的 consumer-owned 端口，task-execution 保留结构同形的本域合同、不进 public。本 RFC 一并改正。
