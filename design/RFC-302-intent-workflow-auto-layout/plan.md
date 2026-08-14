# RFC-302 Intent 新建工作流自动布局 — 实施计划

状态：**Done（2026-08-14；完整门禁、上库与 exact-SHA CI 均通过）**

## 1. 前置门

- [x] 读取当前 `CLAUDE.md`、`STATE.md`、RFC 索引与共享工作树状态。
- [x] 核对 RFC-199 planner、Intent preview、turn canonicalization、draftHash 与 apply create seam。
- [x] 确认 preview-only 与 apply-only 都会破坏 review/hash/apply exactness。
- [x] 读取 RFC-294 摘要/目标与目标层次，确定 shared kernel + intent domain 落位且零新增偏离。
- [x] RFC-302 proposal/design/plan、`design/plan.md` 与 `STATE.md` 落档。
- [x] 用户明确批准 D1-D6 与 AC-1～AC-9；批准前不改 production/test/dependency/lockfile。
- [x] 开工时重读 live 指令，检查共享 tree；若目标文件出现他人并发改动，先调和而非覆盖。
- [x] 请批前设计门复核 single-kernel extraction、raw Intent identity adapter、byte/hash/error 与旧草稿负空间；3 条 P2 已修订，
      当前会话 0 条未处置 P1/P2（见 `design.md` §12；未启动独立 companion）。

## 2. 实施批次

### 批 A — Shared geometry 与唯一 planner

| #          | 任务                                                                                        | 验证                                       |
| ---------- | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| RFC-302-T1 | 抽 `effectiveWorkflowNodePosition` 与默认 node geometry 到 shared                           | 旧 fallback exact + source ratchet         |
| RFC-302-T2 | 抽 planner 所需 wrapper fit/clearance 到 shared，frontend 保留 presentation minimum adapter | wrapper fixture byte/geometry parity       |
| RFC-302-T3 | 移 `planWorkflowLayout` 到 shared，增加 optional fixed root anchor 与 algorithm version     | DAG/cycle/wrapper/idempotence/immutability |
| RFC-302-T4 | frontend 改直接消费 shared planner；删除算法旧文件/只留明确一跳 re-export                   | editor adapter/history/warning tests       |
| RFC-302-T5 | shared 增 Dagre direct dependency并更新 lockfile；保留 structureGraph 独立合法消费者        | depcheck/typecheck/source ledger           |

退出门：editor 自动布局在 full/selection、measured size、Undo/warning 上零行为差异；workflow planner 只有一份。

### 批 B — Intent domain canonicalization

| #           | 任务                                                                                       | 验证                                   |
| ----------- | ------------------------------------------------------------------------------------------ | -------------------------------------- |
| RFC-302-T6  | 新增纯 `normalizeIntentWorkflowCreateLayouts`，只匹配 workflow create                      | create/update/copy/non-workflow matrix |
| RFC-302-T7  | 实现 raw agentRef/call-ref 私有 projection 与 geometry-only 回投                           | identity/order/secret-pointer exact    |
| RFC-302-T8  | 归约 invalid/overflow/cycle，保证任意 schema-legal changeset 不 throw                      | mutation + malformed fixtures          |
| RFC-302-T9  | fixed `{80,80}` anchor、默认尺寸、post-layout canonical bytes 与第二次 size limit          | boundary/idempotence/determinism       |
| RFC-302-T10 | turnEngine 接 `parse→normalize→canonicalize→validate→settle`，布局错误进入 blocking errors | draft row/hash/session DTO integration |

退出门：任何新 create-workflow 的 review source 都是 normalized canonical JSON；失败不生成半布局/错误 hash。

### 批 C — Preview/apply exactness 与兼容

| #           | 任务                                                                                | 验证                               |
| ----------- | ----------------------------------------------------------------------------------- | ---------------------------------- |
| RFC-302-T11 | 锁 inline/expanded Intent preview 接收同一 persisted definition，raw JSON 同坐标    | frontend component tests           |
| RFC-302-T12 | 锁 apply create 的 DB definition 与 confirmed draft geometry exact，不在 apply 重跑 | backend integration + replay       |
| RFC-302-T13 | 旧 draft、update、update→copy、task/other preview surface 负空间                    | compatibility fixtures/source lock |
| RFC-302-T14 | invalid/sizeLocked/cycle 错误在既有 Review blocked/op error UI 可读，无新私有 UI    | frontend/backend integration       |

退出门：审核、hash、apply 与 editor 首次打开同一 geometry；旧路径不静默变动。

### 批 D — 系统验收与门禁

| #           | 任务                                                                                           | 验证                   |
| ----------- | ---------------------------------------------------------------------------------------------- | ---------------------- |
| RFC-302-T15 | daemon + deterministic Intent runtime 生成重叠 DAG，browser review→commit→editor               | real system E2E        |
| RFC-302-T16 | nested wrapper + legal cycle；desktop/390px/light/dark/axe/scroll 与几何断言                   | Playwright/visual/a11y |
| RFC-302-T17 | 固定 SHA 实现门：single kernel、hash exactness、identity/secret pointer、rollback/旧草稿负空间 | 0 unresolved P1/P2     |
| RFC-302-T18 | 定向测试、三包 typecheck/lint/format/depcheck、`bun run gate:local`                            | complete local gate    |

退出门：Proposal AC 全部有自动化证据，完整门禁全绿后才可标 Done。

## 3. 用例矩阵

### 3.1 正常布局

- 1 node、linear DAG、branch/merge、disconnected component；
- 全无 position、全相同 position、极大/负数 position；
- nested git→loop→fanout，inner/outside dependency 的 LCA projection；
- boundary/system channel 不重复 rank；合法 cycle stable back-edge；
- 两个 workflow create op 在同一 changeset 独立固定到各自 `{80,80}`；
- 100 次相同输入得到相同 canonical JSON，normalized output 再 normalize 不变。

### 3.2 保留面

- op/tempRef/handle/agentRef/workflowRef/workgroupRef exact；
- node/edge/op 数量与顺序 exact；prompt/script env/secret sentinel 的 JSON pointer exact；
- wrapper membership/edge/port/business fields exact；
- workflow update、update→copy、agent/workgroup/etc op exact；
- editor selection layout、full layout、history/Undo、fitView 与 visible warning exact；
- task/workgroup-preview/intent-preview 不因 `readOnly` 自动调用 planner。

### 3.3 异常与边界

- unknown kind、duplicate id、bad edge endpoint、NaN/Infinity-like decoded geometry、cyclic membership；
- sizeLocked wrapper overflow；empty wrapper；0 node workflow；
- post-layout canonical bytes = limit 与 limit+1；
- normalizer internal throw 被 stable error 收口且 payload 不进日志；
- stale/superseded/context moved draft 仍按原 CAS 拒绝；
- apply crash/replay/compensation 不二次布局、不漂移坐标。

### 3.4 升降级

- 部署前 old draft 保持原 hash/raw positions 并可按旧语义提交；
- 部署后 new draft 被旧代码读取/提交时 position/size 保留；
- rollback 后只停止生成新自动布局，不改已经创建的 workflow/draft；
- 不存在 marker/backfill/lazy write 或“缺 position 即升级”的旁路。

## 4. 验收映射

| Proposal AC                          | 任务               |
| ------------------------------------ | ------------------ |
| create fixed-anchor auto layout      | T3、T6-T10、T15    |
| DAG/cycle/wrapper/determinism        | T1-T3、T9、T15-T16 |
| geometry-only/identity preservation  | T7、T13、T17       |
| review/hash/apply exactness          | T10-T12、T15、T17  |
| update/copy/old draft negative space | T6、T13、T17       |
| fail-closed/byte limit               | T8-T10、T14        |
| editor/other surface unchanged       | T4、T11、T13       |
| single kernel/RFC-294                | T1-T5、T17         |
| E2E/full gate                        | T15-T18            |

## 5. 提交建议

获批后直接在共享 `main` 小步提交，不建分支、不 broad-stage：

1. `refactor(workflow): RFC-302 共享唯一自动布局规划器`
2. `feat(intent): RFC-302 新建工作流草稿自动布局`
3. `test(e2e): RFC-302 锁定复核与提交布局一致性`

每个 production commit 同时包含对应测试。提交前只暂存本 RFC owned paths/hunks；按仓库规则使用本会话实际模型的
`Co-Authored-By` trailer，并在 push 前用 `git show -s --format=%B HEAD` 核验。

## 6. 完成定义

- [x] 用户明确批准后才修改 production/test/dependency/lockfile；共享 `main` 上其他人的 WIP 未纳入本 RFC 提交。
- [x] T1-T18、AC-1～AC-9、设计门/实现门、真实 E2E 与完整 local gate 全部完成。
- [x] 最终 `gate:local`：shared 2079、frontend 6426、backend 10110 pass / 35 skip / 0 fail。
- [x] RFC-302 Chromium/WebKit 4/4；相邻 RFC-287 修复的真实双仓后端文件 10/10、S-14 3/3、RFC-024/RFC-248 Chromium
      2/2。
- [x] 实现 `1322226f` 与相邻修复 `574d2c67` 已进入 `origin/main`；精确 SHA 主 CI `31762926366` 36/36 全绿（含 Windows）。
- [x] 未执行部署，未声称 live service 状态改变。
