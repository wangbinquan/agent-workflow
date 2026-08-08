# RFC-271 · 任务分解

配套 `proposal.md` / `design.md`。批次内可并行，批次间有依赖。每个批次落地时**自带测试**
（CLAUDE.md「Test-with-every-change」），`bun run gate:local` 全绿才推。

## 批次 A · shared 契约层

无前置依赖，是后面所有批次的地基。

- **RFC-271-T1** `packages/shared/src/resourcePackage.ts`：`PACKAGE_FORMAT_VERSION` /
  `PACKAGE_LIMITS`（复用 `SKILL_ZIP_LIMITS`）/ `PACKAGE_DIRS` / `PACKAGE_SECRET_PLACEHOLDER` /
  `PACKAGE_SECRET_FIELDS`。
- **RFC-271-T2** manifest schema：`PackageManifestSchema` + `PackageResourceEntrySchema` +
  `PackageRequirementsSchema` + `PackageEdgeSchema`。
- **RFC-271-T3** 三个可移植文档 schema：`PortableMcpSchema` / `PortablePluginSchema` /
  `PortableWorkgroupSchema`（含 `PortableWorkgroupMemberSchema` 与
  `leaderDisplayName ↔ leaderMemberId` 换算纯函数）。
- **RFC-271-T4** 闭包遍历纯函数：`directRefsOf` / `walkClosure`（BFS + visited 去重去环 +
  稳定顺序）。
- **RFC-271-T5** 从 `index.ts` re-export；shared 四个测试文件（见 design §9）。

## 批次 B · 后端导出引擎

依赖 A。

- **RFC-271-T6** `util/zip.ts` 的 `encodeZip`（store-only；`decodeZip` 的对偶，round-trip 单测）。
- **RFC-271-T7** `services/resourcePackage/loader.ts`：按类型批量装载器（每层每类型一次
  `inArray`），含名字域引用解析（0 命中 → dangling / 2+ 命中 → 422）。
- **RFC-271-T8** `services/resourcePackage/serialize.ts`：六类 → 包内文档；脱敏 +
  `manifest.secrets` 索引；`requirements` 收集；`builtins` 分流；文件名消歧。
- **RFC-271-T9** `services/resourcePackage/export.ts`：编排 §2.1 全流程；三道门
  （不可见 422 / 特权节点 422 / 超限 422）。
- **RFC-271-T10** `README.md` 生成器（依赖图 + 环境要求 + 待填密钥 + dangling 警示，双语按
  导出者语言？**否**——README 固定中英双段，包是跨人跨机的产物，不跟当前用户语言走）。
- **RFC-271-T11** backend 导出测试两文件（`rfc271-export-closure` / `rfc271-export-gates`）。

## 批次 C · 后端导入引擎

依赖 A、B（T6 的 zip round-trip、T8 的序列化形态）。

- **RFC-271-T12** `services/resourcePackage/parse.ts`：解 zip（复用 `decodeZip` 的归一化）+
  manifest 校验 + 防夹带（未登记条目 422）+ `formatVersion` 判定。
- **RFC-271-T13** `services/resourcePackage/preview.ts`：逐条匹配（自己的 → 候选 → 无）、
  动作可选性（overwrite 仅限自己拥有）、建议副本名、权限缺口、密钥字段、内置件检查、人类席位。
- **RFC-271-T14** `services/resourcePackage/commit.ts` 三段式落地 + 拓扑序 + 引用重绑 +
  fence 复核。
- **RFC-271-T15** 补偿路径：批量 backup 台账、第 3 段失败的回滚、启动期暂存目录清扫。
- **RFC-271-T16** backend 导入测试三文件（`preview` / `commit` / `antitamper`），故障点注入
  用测试 seam。

## 批次 D · 路由与权限

依赖 B、C。

- **RFC-271-T17** 六条 `GET /api/<type>/:id/export-package`（工作流 / 工作组带
  `expectedVersion`）。
- **RFC-271-T18** `POST /api/resource-packages/preview` + `/commit`（`tokenAccess: 'deny'`）。
- **RFC-271-T19** 错误码族登记 + `route-error-code-coverage` 点名测试。
  ⚠️ 新文件先 `git add -N` 再跑门禁，否则该测试扫不到（`docs/dev-gotchas.md` 定式）。
- **RFC-271-T20** `client.ts` 新增六个导出方法 + 两个导入方法。

## 批次 E · 前端导出入口

依赖 D。

- **RFC-271-T21** `lib/resource-package-download.ts`（抽出 `safeDownloadBaseName` 共用）。
- **RFC-271-T22** 工作流编辑页「导出 YAML」→「导出配置包」原地替换。
- **RFC-271-T23** 工作组详情页动作抽屉新增导出（今天没有）。
- **RFC-271-T24** 代理 / 技能 / MCP / 插件详情页各新增一条。
- **RFC-271-T25** 中英双语 i18n key（⚠️ i18n 值里禁字面 `**`，RFC-266 教训）。
- **RFC-271-T26** `rfc271-export-actions.test.tsx`。

## 批次 F · 前端导入预检页

依赖 D。

- **RFC-271-T27** `components/ResourcePackageImportDialog.tsx`：`<Dialog size="full">` +
  `.segmented` + `<Select>` + `<Field>/<TextInput>` + `<StatusChip>`，**零自写 chrome**。
- **RFC-271-T28** 六类列表页导入按钮 + 统一入口 + 类型不符跳转（透传已解析文件）。
- **RFC-271-T29** 导入报告视图（新建 / 复用 / 覆盖 / 待补密钥 / 环境要求四栏）。
- **RFC-271-T30** `rfc271-import-dialog.test.tsx`。
- **RFC-271-T31** 视觉对齐自查：与 `/agents`、`/workflows`、`/repos`、`/settings` side-by-side
  比按钮高度 / 圆角 / spacing / 字号（CLAUDE.md 前端一致性规程第 4 条）。

## 批次 G · CLI

依赖 B、C。

- **RFC-271-T32** `cli/package.ts`：`export-package` / `import-package`；`--as-user` 必填并
  构造同构 `Actor`。
- **RFC-271-T33** `--plan` / `--apply` 决策文件 schema 与读写；`--on-conflict` 语法糖
  （与 `--plan` 互斥）。
- **RFC-271-T34** `cli/start.ts` 命令表注册 + `--help` 文案。
- **RFC-271-T35** `rfc271-cli.test.ts`（含「CLI 不是权限旁路」的对照用例）。

## 批次 H · 能力下线（C1–C5）

**放在最后**：前面批次全绿、新路径可用后才拆旧的，避免中途出现「新的没好、旧的没了」的窗口。

- **RFC-271-T36** 删 `GET /api/workflows/:id/export` 与 `POST /api/workflows/import` 两条路由，
  及 `services/workflow.yaml.ts` 中只服务它们的部分（`stringifyWorkflowYaml` /
  `previewWorkflowYaml` / `importWorkflowYaml`）。
  ⚠️ `workflowDefinitionToSelectors` 与 `stripCallWorkflowNodeIds` **保留**——包导出继续用。
- **RFC-271-T37** 删 `lib/workflow-draft-export.ts` 的本地草稿导出路径（C3）与编辑页救援态
  「导出本地 YAML」按钮。
- **RFC-271-T38** 删 `components/WorkflowImportDialog.tsx` 及其 YAML 路径（C2）。
- **RFC-271-T39** `rfc271-capability-removal.test.ts`：三条源码层文本断言 + 路由不再注册断言。
- **RFC-271-T40** 显式改判既有断言（design §9 表格七项），每处在测试里写明改判理由。

## 批次 I · 文档与记档

- **RFC-271-T41** 新建 `docs/resource-packages.md`：包格式规范、目录结构、manifest 字段表、
  导入流程、CLI 用法、常见失败原因对照表。
- **RFC-271-T42** `design/plan.md` 的「RFC 索引」登记 RFC-271；`STATE.md` 状态改 Done 并加一行
  已完成条目。
- **RFC-271-T43** RFC-270 `design.md §2.2` 关于 export 出口的描述勘误（C4 改判）；
  RFC-199 关于 B2 本地草稿导出的描述勘误（C3 删除）；RFC-223 / RFC-243 中提及「YAML 导出」的
  段落改指配置包。
- **RFC-271-T44** `docs/dev-gotchas.md` 补本次踩到的通用坑（若有）。

## PR 拆分建议

单 RFC 单 PR 是本仓默认，但本 RFC 体量大（预计 40+ 文件）。建议拆三个 commit 推同一条 `main`：

1. `feat(shared,backend): RFC-271 配置包导出`（A + B + D 的导出半边）
2. `feat(backend,frontend): RFC-271 配置包导入与 CLI`（C + D 导入半边 + E + F + G）
3. `refactor(workflow): RFC-271 下线 YAML 导出/导入路径`（H + I）

每个 commit 单独跑全套门禁并推送，推完按 exact SHA 查 CI。

## 验收清单

- [ ] AC-1 … AC-31 逐条有测试点名
- [ ] `bun run gate:local` 全绿
- [ ] 六类根 × 六种闭包形态矩阵跑通
- [ ] 导入回滚的三个故障点注入用例全绿（DB 与 FS 都验干净）
- [ ] C1–C5 每条都有源码层文本断言
- [ ] 前端视觉对齐自查完成
- [ ] Codex 设计门（本文件请批前）+ 实现门（declare done 前）各跑一次并修 findings
- [ ] 推送后按 exact SHA 查 CI 绿

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| 批量 FS 回滚写错 → 用户技能被删 | 覆盖前先移到暂存 backup；三个故障点注入用例；启动期扫残留 |
| 闭包遍历漏一类引用 → 包不完整但看起来成功 | `directRefsOf` 的每类规则与 `resourceRefs.ts` 既有提取器共用；矩阵测试 |
| 脱敏漏一个字段 → 密钥进包 | 字段清单与 `redactMcpRecord` 共用一份，测试断言两边一致 |
| C1/C2 下线打断用户既有自动化 | 已在 proposal §5 逐条呈用户确认；发布说明必须点名 |
| zip 实现自己写引入 bug | store-only 最小实现 + 与 `decodeZip` 的 round-trip 单测 |
| 包体积 64 MB 上限对大技能库不够 | 超限错误点名具体资源，用户可拆包；上限是共享常量，日后调一处即可 |

**回滚**：批次 H 之前的任何时点都可安全停下——新路径是纯增量，旧路径未动。H 一旦落地则
回滚需 revert 三个 commit。
