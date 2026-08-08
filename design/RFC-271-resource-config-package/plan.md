# RFC-271 · 任务分解

配套 `proposal.md` / `design.md`（均为吸收 Codex 设计门第一轮 12 条 findings 后的版本）。批次内可并行，
批次间有依赖。每个批次落地时**自带测试**（CLAUDE.md「Test-with-every-change」），
`bun run gate:local` 全绿才推。

## 批次 A · shared 契约层

无前置依赖，是后面所有批次的地基。

- **RFC-271-T1** `packages/shared/src/resourcePackage.ts`：`PACKAGE_FORMAT_VERSION` /
  `PACKAGE_LIMITS`（复用 `SKILL_ZIP_LIMITS`）/ `PACKAGE_DIRS` / `PACKAGE_SECRET_PLACEHOLDER`。
- **RFC-271-T2** **`packageResourceKey` 分配器**（Codex B1）：`(type, name, ownerDisambiguator)`
  → 稳定唯一 key，不含源实例信息；同名不同 owner 必须分开。
- **RFC-271-T3** manifest schema：`PackageManifestSchema` + `PackageResourceEntrySchema`（带
  `key`）+ `PackageRequirementsSchema`（**五段**，含 `projectSkills`）+ `PackageEdgeSchema` +
  `ambiguousCallRefs`。
- **RFC-271-T4** 三个可移植文档 schema（引用一律 key 域）+ 工作组
  `leaderDisplayName ↔ leaderMemberId` 换算纯函数。
- **RFC-271-T5** 闭包遍历：`directRefsOf` / `walkClosure`（BFS + visited 去重去环 + 稳定顺序）。
- **RFC-271-T6** 从 `index.ts` re-export；shared 四个测试文件（design §9）。

## 批次 B · 后端导出引擎

依赖 A。

- **RFC-271-T7** `util/zip.ts` 的 `encodeZip`（store-only；与 `decodeZip` round-trip 单测）。
- **RFC-271-T8** `services/resourcePackage/loader.ts`：批量装载器（每层每类型一次 `inArray`）。
- **RFC-271-T9** **两域可见性规则**（Codex C1）：id 域不可见 → 422；name 域「零匹配」与
  「全不可见」**逐字节同形** → dangling；2+ 可见候选按最老 ULID 选定并记 `ambiguousCallRefs`。
- **RFC-271-T10** `serialize.ts`：六类 → 包内文档；**脱敏复用 `intentSecretSlots.ts`**
  （`projectMcpForDump` / `projectPluginForDump` / `maskFreeJsonSecrets` / `redactUrlForDump` /
  `maskWorkflowScriptEnv` + `scanForCredentialPatterns` 兜底）；`requirements` 收集（五段，
  plugin spec 同样脱敏）；`builtins` 分流；文件名消歧。
- **RFC-271-T11** **分轴特权门**（Codex C2）：`lens.scripts && hasScript` 与
  `lens.codeHost && hasCodeHost` 各自独立判定。
- **RFC-271-T12** `export.ts` 编排 + 三道门（id 域行级可见性 / 分轴特权 / 超限）。
  ⚠️ **不要**逐类校验 `*:read` 权限点——用户原则「可见即有读权限」，AC-7d 是一条**反向锁**
  （可见但缺该类型权限点时必须导出成功），别顺手补成一道门。
- **RFC-271-T13** `README.md` 生成器（依赖图 + 环境要求 + 待填密钥 + dangling 警示 +
  二义候选标注）。**固定中英双段**，不跟当前用户语言走——包是跨人跨机的产物。
- **RFC-271-T14** backend 导出测试两文件（`export-closure` / `export-gates`，含 AC-7b 的
  逐字节对照与 AC-33 的分轴权限矩阵）。

## 批次 C · 后端导入引擎

依赖 A、B。**本批次是全 RFC 风险最高的一块。**

- **RFC-271-T15** 迁移 + 新表 `resource_package_imports`（形态照抄 `intent_apply_journal`）。
- **RFC-271-T16** `parse.ts`：解 zip（复用 `decodeZip` 归一化）+ manifest 校验 + 防夹带 +
  `formatVersion` 判定。
- **RFC-271-T17** `preview.ts`：按 key 逐条匹配、**`ownMatches[]` 支持多个**（AC-14b）、
  动作可选性、建议副本名、权限缺口、密钥字段、内置件检查、人类席位。
- **RFC-271-T18** **pre-stage 阶段**：预铸六类 id；技能走 `stageManagedSkill(..., {id})`、
  插件走 `installPlugin`；逐个记进 journal artifacts。
  ⚠️ **绝不**自造「裸 DB insert + rename」——`skill-zip.ts:415` 注释写明那会留下
  `versionState='legacy-unbackfilled'`，**单测能过但活 daemon 上每次都挂**。
- **RFC-271-T19** **big tx**：CAS `prepared→applying`；内容级 CAS（工作流/工作组
  `expectedVersion`、代理 `expectedUpdatedAt+expectedAclRevision`、MCP/插件
  `expectedConfigHash`、技能 `contentVersion+metaRevision+aclRevision`）+
  `skill_operation_locks`；`commitSkillReadyInTx` / `commitSkillVersion` / plugin 插入内核 /
  三类 CRUD；**按 `packageResourceKey` 回填全部引用**；journal → `committed`。
- **RFC-271-T20** 幂等尾 + **启动期与每小时收敛**（prepared/applying → 逆序补偿 → failed；
  committed → 重放幂等尾）。收敛逻辑若能与 `applyChangeset` 那份抽出共用则共用。
- **RFC-271-T21** backend 导入测试四文件（`preview` / `commit` / **`kernels`** /
  `antitamper`）。`kernels` 是 AC-25 的专门防线：导入后的技能必须过 `skillBootVerify`、
  有 v1 快照与 content hash，插件 `cached_path` 非空。

## 批次 D · 路由与权限

依赖 B、C。

- **RFC-271-T22** 六条 `GET /api/<type>/:id/export-package`（工作流 / 工作组带
  `expectedVersion`）。
- **RFC-271-T23** `POST /api/resource-packages/preview` + `/commit`，**`tokenAccess:'allow'`**
  （合法值是 `'allow' | 'never'`，没有 `'deny'`；`'never'` 只为 RFC-247 的 D5/D6 存在，创建
  资源不在其列）。授权靠逐类权限点，令牌与界面逐字一致（AC-30 / AC-30b）。
- **RFC-271-T24** 错误码族登记 + `route-error-code-coverage` 点名测试。
  ⚠️ 新文件先 `git add -N` 再跑门禁，否则该测试用 `git ls-files` 扫不到。
- **RFC-271-T25** `client.ts` 新增六个导出方法 + 两个导入方法。

## 批次 E · 前端导出入口

依赖 D。

- **RFC-271-T26** `lib/resource-package-download.ts`（抽出 `safeDownloadBaseName` 共用）。
- **RFC-271-T27** 工作流编辑页「导出 YAML」→「导出配置包」原地替换。
- **RFC-271-T28** 工作组详情页动作抽屉新增导出（今天没有）。
- **RFC-271-T29** 代理 / 技能 / MCP / 插件详情页各新增一条。
- **RFC-271-T30** 中英双语 i18n key（⚠️ i18n 值里禁字面 `**`，RFC-266 教训）。
- **RFC-271-T31** `rfc271-export-actions.test.tsx`。

## 批次 F · 前端导入预检页

依赖 D。

- **RFC-271-T32** `components/ResourcePackageImportDialog.tsx`：`<Dialog size="full">` +
  `.segmented` + `<Select>` + `<Field>/<TextInput>` + `<StatusChip>`，**零自写 chrome**。
- **RFC-271-T33** 多 own match 选择器（AC-14b）+ 密钥输入 + 副本改名 + 人类席位指派。
- **RFC-271-T34** 六类列表页导入按钮 + 统一入口 + 类型不符跳转（透传已解析文件）。
- **RFC-271-T35** 导入报告视图（新建 / 复用 / 覆盖 / 待补密钥 / 环境要求 / 内置依赖）。
- **RFC-271-T36** `rfc271-import-dialog.test.tsx`。
- **RFC-271-T37** 视觉对齐自查：与 `/agents`、`/workflows`、`/repos`、`/settings`
  side-by-side 比按钮高度 / 圆角 / spacing / 字号（CLAUDE.md 前端一致性规程第 4 条）。

## 批次 G · CLI

依赖 B、C。

- **RFC-271-T38** `cli/package.ts`：`export-package` / `import-package`；**两条都必须
  `--as-user`** 并构造与 HTTP 同构的 `Actor`。
- **RFC-271-T39** `--plan` / `--apply` 决策文件 schema 与读写；`--on-conflict` 语法糖
  （与 `--plan` 互斥）。
- **RFC-271-T40** `cli/start.ts` 命令表注册 + `--help` 文案（写明 break-glass 边界）。
- **RFC-271-T41** `rfc271-cli.test.ts`（含「CLI 不是权限旁路」对照用例、缺 `--as-user` 退出）。

## 批次 H · 能力下线（C1–C6）

**放在最后**：前面批次全绿、新路径可用后才拆旧的，避免中途出现「新的没好、旧的没了」的窗口。

- **RFC-271-T42** 删 `GET /api/workflows/:id/export` 与 `POST /api/workflows/import` 两条路由，
  及 `services/workflow.yaml.ts` 中只服务它们的部分。
  ⚠️ `workflowDefinitionToSelectors` / `stripCallWorkflowNodeIds` **保留**——包导出继续用。
- **RFC-271-T43** 删 `lib/workflow-draft-export.ts` 的本地草稿导出路径（C3）与编辑页救援态
  「导出本地 YAML」按钮。
- **RFC-271-T44** 删 `components/WorkflowImportDialog.tsx` 及其 YAML 路径（C2）。
- **RFC-271-T45** `rfc271-capability-removal.test.ts`：源码层文本断言 + 两条旧路由不再注册；
  另在 `rfc271-routes.test.ts` 锁住导入端点是 `'allow'` 且缺权限令牌提交 422。
- **RFC-271-T46** 显式改判既有断言（design §9 表格七项），每处写明改判理由。

## 批次 I · 文档与记档

- **RFC-271-T47** 新建 `docs/resource-packages.md`：包格式规范、目录结构、manifest 字段表、
  `packageResourceKey` 语义、导入流程与收敛语义、CLI 用法（含 break-glass 声明）、
  **「技能文件树里的密钥属于作者责任」**、常见失败原因对照表。
- **RFC-271-T48** `design/plan.md` 索引状态改 Done；`STATE.md` 加已完成条目。
- **RFC-271-T49** 勘误：RFC-270 `design.md §2.2` 的 export 出口描述（C4 改判）；RFC-199 的 B2
  本地草稿导出（C3 删除）；RFC-223 / RFC-243 中提及「YAML 导出」的段落改指配置包。
- **RFC-271-T50** `docs/dev-gotchas.md` 补本次沉淀（至少一条已确定：**「多资源批量落地不要
  自造 DB+FS 顺序，先查有没有既成的 pre-stage/commit 内核」**——本 RFC 初稿正是把顺序写反了，
  而 `skill-zip.ts:415` 早把代价写在注释里）。

## PR 拆分建议

单 RFC 单 PR 是本仓默认，但本 RFC 体量大（预计 45+ 文件）。建议拆三个 commit 推同一条 `main`：

1. `feat(shared,backend): RFC-271 配置包导出`（A + B + D 的导出半边）
2. `feat(backend,frontend): RFC-271 配置包导入与 CLI`（C + D 导入半边 + E + F + G）
3. `refactor(workflow): RFC-271 下线 YAML 导出/导入路径`（H + I）

每个 commit 单独跑全套门禁并推送，推完按 exact SHA 查 CI。

## 验收清单

- [ ] AC-1 … AC-34（含 AC-7d）逐条有测试点名
- [ ] `bun run gate:local` 全绿
- [ ] 六类根 × 九种闭包形态矩阵跑通（含同名不同 owner、传递不可见）
- [ ] **AC-7b 预言机对照**：零匹配 vs 全不可见，响应逐字节相同
- [ ] **AC-25 内核锁**：导入后的技能过 `skillBootVerify`、插件 `cached_path` 非空
- [ ] **AC-20 收敛**：journal 各 phase 边界注入中断 + 重启，收敛到二态之一
- [ ] **AC-24 并发**：两个 actor 同目标导入，后者 409
- [ ] C1–C6 每条都有源码层文本断言
- [ ] 前端视觉对齐自查完成
- [ ] Codex 实现门（declare done 前）跑一次并修 findings
- [ ] 推送后按 exact SHA 查 CI 绿

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| 批量落地写错 → 用户技能被毁 | **不自造路径**，全走 `stageManagedSkill` / `commitSkillReadyInTx` / `commitSkillVersion`；AC-25 内核锁 + AC-20 中断注入 |
| 收敛逻辑与 `applyChangeset` 那份漂移 | 能抽出就共用；不能则互相加断言锁 |
| 闭包遍历漏一类引用 | `directRefsOf` 与 `resourceRefs.ts` 既有提取器同源；矩阵测试 |
| 脱敏漏一个载体 | 复用 `intentSecretSlots.ts` 而非自造清单；**逐 carrier** 测试而非「与某函数一致」 |
| 预言机回归 | AC-7b 逐字节对照断言，任何分支差异都会红 |
| C1/C2/C6 打断用户既有自动化 | `proposal.md §5` 逐条呈用户确认；发布说明必须点名，尤其 **C6（传递不可见闭包不再可导出——工作流仍能跑，只是导不出）** |
| zip 实现自写引入 bug | store-only 最小实现 + round-trip 单测 |
| 64 MB 上限对大技能库不够 | 超限错误点名具体资源；上限是共享常量，日后调一处 |

**回滚**：批次 H 之前的任何时点都可安全停下——新路径是纯增量，旧路径未动（新表已建但无行时
无副作用）。H 落地后回滚需 revert 三个 commit。
