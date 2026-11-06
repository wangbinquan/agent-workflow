# RFC-455 资源包一族归 resource-catalog（RFC-294 W9-D、RFC-345 T6 余项）

- **状态**：Done（2026-11-06，落地 `519d9372a`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 实现文件按 owner 归位）
- **前序**：[RFC-454](../RFC-454-services-one-hop-facade-sweep/proposal.md)（`services/` 一跳转出清仓）；
  [RFC-345](../RFC-345-resource-catalog-contract-cutover/proposal.md) T6（资源包 public operations 已落，算法层仍在 `services/`）。
- **落位**：resource-catalog 的 `application/package`（算法层）、`domain`（纯计划、校验与解码）、`composition`（两个装配绑定）。

## 1. 背景

RFC-345 T6 把资源包的 public operations、`ResourcePackageApplyTx` 与 `application/package/{packageApplication,ports}.ts` 落进了
resource-catalog，但「把 parse / inspect / preview / apply / receipt / export 组织到 `resource-catalog/application/package`」一项没收口：
算法层仍是 `services/resourcePackage/**` 的 13 个文件，加上 `services/bundle/provider.ts`（依赖规划与回执合同）与两个操作修订摘要
（`services/mcpOperationRevision.ts`、`services/pluginOperationRevision.ts`），共 16 个文件约 4.1K 行。RFC-454 之后实测：

- 这 16 个文件的生产消费方全在 resource-catalog（原子应用的场景适配器、MCP 诊断）、bootstrap（两个装配绑定）与 intent（清单里的两个
  修订摘要；intent → resource-catalog 是目标 DAG 给的边）；
- 它们不取任何其他模块的内部，只取 shared、`util`、`auth` 的类型、resource-catalog 自己的 public 类型与两处内部（`legacy/skill-zip` 的
  `decodeZip`、`local/filePluginInstallation`），以及 `services/resourceAcl` 转出的 `isVisibleRow`（实现在 resource-catalog `domain`）；
- 边界账本里记着它们：`R1`（legacy → 模块内部）两条、`R2`（模块 → legacy）九条，`removeAfterWave` 就写着「services/resourcePackage/\*\* →
  resource-catalog/package」；RFC-345 的 facade 登记表把 closure / export / preview 三条 `isVisibleRow` 边记为待移除。

## 2. 目标

- **G1 归位**：16 个文件迁出 `services/`——算法层进 resource-catalog `application/package`，纯计划 / 校验 / 解码进 `domain`，两个装配
  绑定进 `composition`；`services/resourcePackage/` 与 `services/bundle/` 目录删除。
- **G2 不新增越界**：模块内部只经本模块的相对路径取；intent 经 resource-catalog `public/queries` 取修订摘要；application 不取
  infrastructure（`decodeZip` 的纯解码段从 `legacy/skill-zip.ts` 拆进 `domain`）；不新增 public surface 偏差、`module-layer-violations`、
  跨 context 内部文件对与 off-DAG 边。
- **G3 行为不变**：只换位置与 import；函数体原样。唯一的合一是结构完全相同的读端口：算法层自带的 `ResourcePackageReadPort` /
  `ResourcePackageResourceSnapshot` 与 `application/package/ports.ts` 里的同名合同逐字段相同，迁入后只留 ports 里那一份。
- **G4 账本收口**：`R1` / `R2` 按实测销账；RFC-345 facade 登记表删去三条 `isVisibleRow` 边；架构报告的 legacy 归属表删去这 16 个文件。

## 3. 非目标

- 资源写入栈合一（RFC-294 S7 的余项）、application/package 里与 ports 结构相近但不完全相同的合同类型（`ImportDecision`、
  `HumanMemberMapping`、`PackageSecretInput` 等）的合并；`legacy/skill-zip.ts` 其余部分；安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：16 个文件不在 `services/`，`src/` 与用例零引用旧路径；`decodeZip` 只有一份定义（domain）。
- **AC-2**：架构计数按实测：`services/` 123 → 107，`legacy-horizontal-files` 与 `legacy-service-implementations` 各 −16，`R1` / `R2` 下降
  （账本逐条相等）；off-DAG 值边 0、值环 0、平台 → 模块 0、跨 context 内部文件对、public surface 偏差、`module-layer-violations`、
  不可达生产文件不升。
- **AC-3**：资源包的导入预览 / 提交 / 导出 / 往返、技能 zip、MCP 运行时测试与插件发布、原子应用的既有用例全部通过；新增 RFC-455 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **算法层整体进 `application/package`，不逐个文件细分**：RFC-345 T6 写明的落点就是这里；closure / export / preview 经读端口读，
   commit 取 preview，属于用例层。只把被 application 与 infrastructure 两侧共用的纯件放进 `domain`（依赖规划与回执、两个修订摘要、
   zip 解码），否则 infrastructure 的原子应用或 skill-zip 就得反取 application。
2. **`services/bundle/provider.ts` 进 resource-catalog `domain`，不进 platform**：架构报告的归属表把它记作 platform，但它的消费方全在
   resource-catalog，内容是资源类型的依赖规划与回执（`BundleResourceType`、`opSlug`），不是平台机制；表项随文件迁出一并删除。
3. **两个装配绑定进 resource-catalog `composition`**：它们只被 bootstrap 用；执行适配器把 package application 的端口实现成算法层调用，
   插件安装绑定包着 resource-catalog 自己的 `local/filePluginInstallation`，都属于本模块的装配。
