# RFC-231 资源默认私有与工作流/工作组一键复制 — plan

状态：Done（2026-07-27；设计门与实现门均 APPROVED / 0 open P0-P2；实现与验证完成）。

## 任务

- [x] **T1 现状定位与产品边界**：核对六类 ACL 闭集、所有 production INSERT、built-in
      例外、两类编辑器 More Dialog、autosave 救援 copy、exact revision/ref gate/WS 行为；
      用户确认 copier owner、全部用户新建 private、现有行不回填、built-in public。
- [x] **T2 设计门与批准**：当前 Codex 会话对三件套和 live source 做只读设计审查，修复
      findings；设计门 3 个 P1、1 个 P2 已全部折入并 APPROVED，用户随后以「ok」批准实施。
- [x] **T3 默认 ACL 单源**：新增 user-private / builtin-public ACL helper；六个 canonical
      create service 与四类 built-in 写点显式接线；更新 legacy DB default 注释，补 production
      writer inventory guard；`dwSaveAsWorkflow` 补传 actor，封住最终 refs fence 的
      implicit-system 旁路。
- [x] **T4 Copy shared/backend**：新增 strict exact-copy schemas、同步事务内 view gate、共用
      copy-name pure helper、`copyWorkflow`/`copyWorkgroup` 原子 service 与两个 201 route；复用/
      抽取 create INSERT primitive，广播在 commit 后。
- [x] **T5 后端回归**：六类 create 跨用户矩阵、派生 create/overwrite、built-in、零 backfill；
      两类 copy 的 owner/private/no-grant/exact revision/ref ACL/命名并发/成员重建/无历史复制；
      WS private-created 不泄露。
- [x] **T6 前端一键复制**：Workflow/Workgroup More action、ensureSaved exact payload、pending/error/
      abort/query cache/navigation、i18n/a11y；保持 conflict save-copy Dialog 独立。
- [x] **T7 前端自动化与真浏览器**：两类 route/component 测试；desktop light Workflow 和 390px
      dark Workgroup 的真实 daemon 鼠标/键盘/overflow/axe 验证。
- [x] **T8 全部门禁**：shared/backend/frontend 定向与相关全量、typecheck/lint/format/depcheck、
      production/test binary smoke；准确记录任何环境 skip/flake，不把隔离绿冒充全量绿。
- [x] **T9 实现门与收尾**：Codex 实现审查并闭合 P0/P1/P2；更新 RFC/STATE/index，复核共享树
      归属。未经用户明确授权不 commit/push。

## 依赖与顺序

```text
T1 → T2 设计门 → 用户批准
                  ├→ T3 默认 ACL 单源 ─┐
                  └→ T4 Copy backend ──┼→ T5 backend/WS
                                       └→ T6 frontend → T7 browser
T5 + T7 → T8 gates → T9 impl gate/收尾
```

T3 与 T4 都会触及 Workflow/Workgroup create primitive，实际落地时先完成 T3 的小型单源抽取，
再在同一共享树上精确接 T4，避免并行编辑同一段 service。单 RFC、单 PR；测试与生产改动同批，
不留下“UI 已出现但 API/ACL 仍旧”的中间版本。

## 计划改动面

### Shared

- `packages/shared/src/schemas/workflow.ts`
- `packages/shared/src/schemas/workgroup.ts`
- shared exports 与 schema tests

### Backend

- `services/resourceAcl.ts` 或等价 ACL 叶子 helper
- `services/agent.ts`
- `services/skill.ts` / `services/skill-zip.ts`（调用链与注释）
- `services/mcp.ts`
- `services/plugin.ts`
- `services/workflow.ts`
- `services/workgroups.ts`
- `services/fusion.ts`
- `services/agentLaunch.ts`
- `services/workgroup/launch.ts`
- `routes/workflows.ts`
- `routes/workgroups.ts`
- `db/schema.ts`（只更新 legacy fallback 注释，不改物理 default）
- backend tests / production-writer guard / WS tests

### Frontend

- `routes/workflows.edit.tsx`
- `routes/workgroups.detail.tsx`
- 中英 i18n
- route/component tests 与必要 E2E fixture

不新增数据库 migration，不修改六表存量 visibility，不修改 backup wire。

## 不变约束

- 用户新建资源：owner 只能来自 actor、visibility 固定 private、aclRevision 0、grants 为空；
  四项均显式 stamp，不依赖数据库默认值。
- built-in：public+builtin 明确写入，不靠 SQLite default。
- 副本 owner 永远是 copier；source owner/visibility/grants 永不传播。
- copy body 不接收目标名称、内容、ACL 或 id。
- copy 只消费一个 exact saved revision，不复制会继续变化的客户端对象。
- 目标全部直接引用按 copier 重验；不能借 public/granted source 升权。
- source visibility/revision 与目标 insert 在同一 `dbTxSync` fresh snapshot。
- Workgroup member rows 全新，leader 只映射到新 member id。
- 正常 copy 无命名 Dialog；救援 save-copy 保留命名 Dialog。
- private created WS 不得泄露 id/name 给 stranger。
- 现有 public/private 行与灾备 restore 原样保持。
- 共享树中的 RFC-230 与未跟踪 RFC-218 gate 文件必须保留；重叠 STATE/index/i18n 只做精确 hunk。

## 验收清单

- [x] AC-1/2：两类 More 一键 copy、先 exact save、无命名表单、成功跳转。
- [x] AC-3/4：新 id/version 1/copier owner/private/revision 0/no grants，源 ACL 不传播。
- [x] AC-5/6：内容完整、Workgroup member id 重建、历史自由格式 Workflow 名可 slugify，命名
      递增/截断/并发正确。
- [x] AC-7：404/stale/ref/human/name 所有失败原子关闭。
- [x] AC-8/9：六类普通与全部派生 user create private；dynamic save 的 actor/ref 事务门不
      旁路；overwrite 不改 ACL。
- [x] AC-10：全部 built-in public+builtin 且运行能力不变。
- [x] AC-11：Workflow/Workgroup private created WS 不泄露。
- [x] AC-12：存量 visibility 零变化、零 migration。
- [x] AC-13：desktop light / 390px dark / keyboard / overflow / axe 通过。
- [x] AC-14：自动化门禁与实现门通过，0 open P0/P1/P2。

## 交付记录（2026-07-27）

- Shared：全量 `1,441 pass / 0 fail`。
- Backend：完整随机化套件 `7,446 pass / 25 env-gated skip / 0 fail`；最后新增的
  exact-copy/race/route 改动再跑定向 `22 pass / 0 fail`。
- Frontend：全量 `5,290 pass / 0 fail`；Workflow/Workgroup copy 定向
  `51 pass / 0 fail`。
- 真浏览器：既有 Workflow editor + Workgroup autosave 两条真实 daemon Playwright 文件
  `19 pass / 0 fail`，新增 Copy 显式断言、键盘 Enter 全链、390px dark、无水平溢出及
  axe WCAG 2A/2AA critical+serious 零问题；另以应用内浏览器手工完成 desktop light
  Workflow 脏草稿复制与 390px dark Workgroup 脏草稿复制。
- 持久层实证：两类副本均为 copier owner、private、version 1、aclRevision 0、0 grants；
  Workgroup 成员 id 已重铸，复制前最后一笔 description/instructions 已进入副本。
- 静态与构建门：三包 typecheck、全仓 lint（仅既有 Node module-type warning）、
  format check、depcheck（1,468 modules / 4,536 dependencies）、production+E2E binary build
  与两个 `v0.17.1` version smoke 全绿。
- 实现门见
  [codex-impl-gate-2026-07-27.md](./codex-impl-gate-2026-07-27.md)：APPROVED，0 open P0/P1/P2。
- 共享树中 RFC-218 gate、RFC-232、RFC-233 均保持原样；发布只纳入 RFC-231 自有改动。

## 提交与发布边界

- 用户批准 RFC 只授权进入实现，不自动授权 commit/push。
- 如后续明确要求提交，按 AGENTS.md 为实际参与实现的 AI 添加真实
  `Co-Authored-By` trailer，并在 push 前用 `git show -s --format=%B HEAD` 核验。
- 共享 `main` 只精确 stage 本 RFC 文件，不使用 `git add -A`，不 amend/rebase/force-push，
  不清理其他 session 的 WIP。
