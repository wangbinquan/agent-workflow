# RFC-218 单 agent 启动端口化表单与启动上传控件收敛 — plan

状态：Done（2026-07-22 交付，见文末交付记录）。依赖：无（RFC-165/166 已交付；与 RFC-217 重构无
耦合面——本 RFC 不触 workgroup 代码）。

## PR 拆分

- **PR-1（独立先行，纯前端）**：上传控件收敛（T1–T3）。不依赖端口化任何改动，先落先受益
  （workflow 启动路径立即改善）。
- **PR-2（主体）**：端口化启动表单（T4–T12）。upload 端口的控件直接站在 PR-1 上。

## 任务

### PR-1 上传控件收敛

- **RFC-218-T1** `FilesDropzone` 原语：`FileDropzone.tsx` 内 sibling 组件（多文件受控 props、
  拖拽深度计数高亮、accept、maxCount、name+size 去重、逐文件删除、error role=alert、
  `data-testid` 家族），共享 `.file-dropzone` 命名空间 + 新增 `__list` 行样式；单文件 API 零改动。
  vitest（design §9-15 前半）。
- **RFC-218-T2** `UploadPicker` 重写为薄适配层（def 解析 + hint 行 + FilesDropzone）；删除
  `.upload-picker__drop` 手搓 drag 样式与代码；i18n 补 dropzone 标题/描述键（`launch.upload.*`
  命名空间内）。源码层文本断言锁（design §9-15 后半）。
- **RFC-218-T3** 视觉自查：最小 repro + chrome 截图 light/dark，与 skills 导入 / agent 导入
  side-by-side 对齐记录；确认 settings 双 OS 视觉基线不受影响（启动页不在基线场景内，预期零刷新）。

### PR-2 端口化启动表单

- **RFC-218-T4** shared 派生层 `agentLaunchForm.ts`：`deriveAgentLaunchForm`（kind 映射矩阵、
  required 默认、blocker：signal/非法名/内建 token 撞名）+ promptTemplate 合成（golden 字节）。
  测试 design §9-1..4。【是后续一切的地基】
- **RFC-218-T5** wire：`StartAgentTaskSchema.description` → optional + 新增 `inputs`；
  scheduled payload 随 extend 继承；`rejectRetiredStartTaskKeys` 键清单核对。e2e 字段 grep
  （[reference_e2e_outside_workspace_typecheck]）。
- **RFC-218-T6** backend 快照合成与形态校验：`buildAgentHostSnapshot(agent, allowClarify)`
  端口化分支（input 节点 `__agent_input_{i}__` / 边 / 模板），零端口路径字节不动；形态校验
  矩阵抽成 `validateAgentLaunchShape(agent, payload)`（description/inputs 互斥、未知键、
  缺必填、blocker、含上传端口的 multipart-only 判定——设计门 P2-2 的共用点）。
  测试 design §9-5..7、9、20、23。
- **RFC-218-T7** multipart 共通化 + 生命周期：从 `handleMultipartTaskStart` 抽
  `services/launchMultipart.ts` 公共骨架（defs 来源 + start 回调参数化），`/api/tasks` 迁移到
  共用层（行为字节不变），`/api/agents/:name/tasks` 接入 multipart 分支、`.agent-inputs/{port}`
  落盘；**执行序按 design §5.2 固定**：内存解析 → `startAgentTask` 完整预检链（ACL/OCC/预约/
  recheck/blocker/F14/字段校验）→ worktree 就绪后落盘 → finally 释放（设计门 P1-2/P1-3）。
  测试 design §9-8、19、20。
- **RFC-218-T8** 前端向导：agent `inputs` 数据可达性核实（列表 DTO 或补 detail query）→
  **数据就绪屏障**（agentsQ 成功且命中行前 LoadingState/ErrorBanner、canProceed false，
  设计门 P1-5）→ `inputDefs` 三元来源 → seed/prune effect 泛化到「以当前 inputDefs 为准」
  （含 uploads 清理，设计门 P1-4）→ 复用 DynamicInput/必填/multipart 判定 → maxLength 贯通
  （设计门 P2-4）→ blocker ErrorBanner + 禁用 → 摘要步分支。`DynamicInput` 增加 chips
  presentation 分支。编辑器侧：shared blocker 接入 `validateAgentPortState` 警告
  （设计门 P2-3）。测试 design §9-12、21、22、23（vitest 部分）、25。
- **RFC-218-T9** 启动 body：`buildAgentStartBody` 按形态 stamp `inputs`/`description` 二选一
  （白名单前科，独立任务 + 锁），且按当前派生 defs 过滤键（设计门 P1-4 第二层）。
  测试 design §9-13。
- **RFC-218-T10** relaunch + scheduled：`taskToLaunchPayload` agent 分支端口化识别用
  `/^__agent_input_\d+__$/` **精确匹配**（设计门 P1-1，附真实零端口快照反例锁）+ 文本预填 +
  upload 键剔除；scheduled create/update 接入 `validateAgentLaunchShape`（设计门 P2-2）；
  火时按当时 agent 重派生（既有路径自然获得，补失败面断言）。测试 design §9-10、11、14、18、24。
- **RFC-218-T11** e2e：`task-wizard.spec.ts` 增双文本端口 stub agent 场景（design §9-16）；
  既有 agent 用例零改动确认。
- **RFC-218-T12** 守卫与收尾：`tasks.new.tsx` inputDefs 表级 grep 锁（design §9-17）；
  `design/plan.md` 索引 + `STATE.md` 状态翻转；release note 草稿注明行为变化
  （proposal §6）。

## 依赖关系

```
T1 → T2 → T3           （PR-1 线性）
T4 → T6 → T7            T4 → T5
T4,T5 → T8 → T9 → T10 → T11 → T12
T2 ⇢ T8（upload 端口控件视觉依赖 PR-1，功能不阻塞）
```

## 验收清单（对照 proposal §5）

- [x] AC-1 端口化 agent 端口表单替换描述框，body 带 inputs 无 description（P1/P2 vitest + e2e）
- [x] AC-2 零端口 agent 字节级现状（rfc218 B2 深等锁 + rfc165 全家族绿）
- [x] AC-3 kind 映射矩阵逐条（shared 矩阵测试含 path\<*\> 与嵌套 list 兜底）
- [x] AC-4 signal 前端禁用 + 后端 422（B3 + P4）
- [x] AC-5 required 默认必填双端拦截（实现门 P1 补编辑器对齐：显式 false 持久化、true 折叠缺省）
- [x] AC-6 XML 端口块统一信封 golden；`{{…}}` verbatim 断言（B4）
- [x] AC-7 上传端口 `.agent-inputs/{port}` 落盘 + 换行路径 wire + multipart-only（JSON 伪造 422）+ 共用护栏（B5）
- [x] AC-8 非法端口名/保留族启动拦截 + 端口编辑器警告（P2-3 落 validateAgentPortState）
- [x] AC-9 relaunch 文本预填 / 上传重选 / 零端口不变（P7 + B4 + P1-1 精确判别反例锁）
- [x] AC-10 scheduled 文本可定时、上传端口保存拒绝 + disabled PUT 替换 payload 也校验（P2-5）
- [x] AC-11 上传控件 FileDropzone 家族体验 + 手搓 drag 删除 + 双主题截图自查（PR-1）
- [x] AC-12 门槛四件套 + 前端 vitest 全绿 + e2e 本地全过 + build:binary smoke 绿；CI 按 sha 追认

## 实现门

- 设计门：**已跑（2026-07-22，Codex review @ abadee24）**——5 P1 + 4 P2 全部裁定有效并修订入
  design.md v2（修订账 design §10，原文 `codex-design-gate-2026-07-22.md`）。
- 实现门：**已跑（2026-07-22）**——PR-2（@ eb262a02）1 P1 + 8 P2 全采纳修入 `2e785c69`
  （原文 `codex-impl-gate-2026-07-22.md`；含 startTask sandbox 闸移位根修 RFC-205 同病）；
  PR-1（@ 0e9e2681）**零 findings**（原文 `codex-impl-gate-pr1-2026-07-22.md`，已核非空转）。
  CI 红两轮均已归属：rfc200-source-lock/工作组三连 = RFC-217 T3a 拆解期间（T3b 已修）；
  agent-port-editor e2e required 徽记 = 本 RFC P1 语义翻转漏改显示点（`129f7f3c` 修）。

## 交付记录（2026-07-22）

- `abadee24` 三件套落档 · `5bf4895c` 设计门修订 v2 · `0e9e2681` PR-1 上传控件收敛 ·
  `eb262a02` PR-2 端口化表单主体 · `cea9201d` routes-no-cast 白名单跟修 ·
  `2e785c69` 实现门九条 · `87fc4dd3` AgentForm-inputs 锁适配 · `129f7f3c` required 徽记跟修
- 测试面：shared agent-launch-form 17 · backend rfc218 17 · frontend rfc218 两套 18 +
  三处旧锁随契约更新（agent-ports/agent-port-dialog/AgentForm-inputs，注明 RFC-218 出处）·
  e2e task-wizard 端口场景 + agent-port-editor 全绿
- 行为变化（proposal §6）已生效：存量声明过 inputs 的 agent 下次启动即端口表单；
  默认必填语义 = `required !== false`
