# RFC-225 工作组版本化自动保存与一致性 UX — plan

状态：In Progress（2026-07-23，用户以「开始」批准；T1-T9 与全部本地门禁已完成；T10
仅剩提交、推送与 exact SHA CI，未获授权故待办）。

依赖：

- RFC-199 工作流版本化自动保存（Done）；
- RFC-201 工作组 composite edit scope（Done）；
- RFC-217 工作组架构重构（Done）；
- RFC-223 已落地的 workgroup id / agentId 内部接缝；最终 id URL 切换前使用 current-name
  compatibility route。

## PR 形态

单 RFC / 单 PR 原子交付。版本 CAS、writer wire、前端 controller 与 Save 按钮移除不能拆成对用户可见
的中间态；PR 内按下列任务分提交，任一提交进入最终 PR 前都必须保持 typecheck/test 可运行。

## 任务

- [x] **RFC-225-T1 revision 基础**：新增 `workgroups.version` migration、WorkgroupDraftSnapshot /
      Revision / SaveReceipt、domain-separated canonical serializer/hash；fresh + rolling-upgrade +
      serializer 纯测试。
- [x] **RFC-225-T2 后端 fenced save**：实现稳定 id 的 `saveWorkgroup` 单写入口；fresh auth、
      logical no-op、already-current replay、`WHERE id+version RETURNING`、config-only 不重建成员、
      changed roster 原子替换与 exact receipt；迁移全部 create/update/rename adapter/delete/direct
      callers。
- [x] **RFC-225-T3 writer/并发守卫**：双 writer 同基线、response loss、owner transfer、引用 ACL、
      name collision、member replace 半写回归；加结构守卫禁止 unfenced workgroup/member 内容写。
- [x] **RFC-225-T4 workgroups WS**：shared frame + `WS_PATHS.workgroups`、broadcaster/registry、ACL cache、
      cold-delete audience、ACL frame、credential/role revalidation；frontend `useWorkgroupSync` reconnect
      invalidation。
- [x] **RFC-225-T5 pure autosave coordinator**：document revision、debounce/immediate、single-flight +
      queued latest、blocked invalid/transient、definitive error、ambiguous reconciliation/backoff、foreign
      conflict、ensureSaved；fake clock/deferred promise 全矩阵。
- [x] **RFC-225-T6 route 接线**：metadata/config/members 接同一 controller；删除页头/member Save、
      `savedFlash` 和 blanket input lock；add/remove/leader/mode 进入 immediate queue；member receipt
      remap不丢 local key/selection/focus。
- [x] **RFC-225-T7 一致性状态 UX**：接 workgroup phase/transport/blocked notices、Retry、ARIA live、
      i18n 与最小 CSS；workflow 状态行为回归不变；workflow/workgroup 共用 `editor-page-header`，
      工作组左侧 title/id/version、右侧 primary Launch + secondary More 对齐。
- [x] **RFC-225-T8 冲突与 exact actions**：另存副本、载入远端、覆盖远端；RenameDialog 同 writer；
      Launch `ensureSaved` 后携 `expectedWorkgroupVersion` 导航；Delete expectedVersion；ACL access wake；
      路由/beforeunload guard 完整。
- [x] **RFC-225-T9 browser/视觉验收**：controller/service 回归覆盖双 context、commit 后断响应、
      WS-before-HTTP/reconnect、invalid/transient、慢保存继续输入与 frozen task snapshot；真实 binary +
      隔离 daemon Playwright 覆盖 autosave PUT v1→v2、1536/1080/390/640×400、light/dark、axe、overflow
      与动作可达；真实浏览器视觉核验并修复 390px 下 More 按钮裁切。
- [ ] **RFC-225-T10 收尾**：本地全量 typecheck/lint/test/format/build-binary、设计验收勾选及
      `design/plan.md` / `STATE.md` 更新已完成；提交后核 co-author trailer、推送并等待 exact SHA CI
      success 尚未获授权。

## 依赖关系

```text
RFC-223 id-canonical
        │
        ▼
T1 ──► T2 ──► T3
 │       │
 │       └────► T4
 │
 └────► T5 ──► T6 ──► T7 ──► T8
                         │       │
                         └──┬────┘
                            ▼
                           T9 ──► T10
```

T4 与 T5 可在 T1 后并行开发，但 T6 只能在 backend receipt 与 pure coordinator 都稳定后接线。

## 验收清单

- [x] AC-1 持久字段全自动保存，零 Save 按钮
- [x] AC-2 single-flight + queued latest，连续编辑不丢
- [x] AC-3 version CAS 阻止静默覆盖
- [x] AC-4 response-loss exact replay 零重复 revision/member churn/frame
- [x] AC-5 invalid/transient 零请求、解释清楚、修复后自动续存
- [x] AC-6 config-only 保 member id；member receipt 保 local UI identity
- [x] AC-7 WS own echo / clean follow / dirty conflict / reconnect 对账
- [x] AC-8 持续可信状态、transport 正交、中英/ARIA/theme
- [x] AC-9 Launch exact-save barrier，运行中 task snapshot 不变
- [x] AC-10 metadata/config/member 单 writer，全写路径 fenced
- [x] AC-11 390/desktop/short viewport 可达且无 overflow
- [ ] AC-12 migration + 全量门禁 + Playwright/visual/axe + exact SHA CI（本地部分全绿；
      exact SHA CI 待提交、推送）
- [x] AC-13 workflow/workgroup 页头 title/id/version 与主次动作层级对齐

## 本地交付证据

- shared：1420 pass / 0 fail；
- backend：6738 pass / 23 个环境条件 skip / 0 fail；
- frontend：5213 pass / 0 fail；
- Playwright RFC-225：真实 binary + 隔离 daemon，1 pass / 0 fail；
- `typecheck`、`lint`、`format:check`、`build:binary`、`git diff --check` 全绿；
- 未提交、未推送，因此 exact SHA CI 尚不存在。

## 设计批准门

- [x] 用户以「开始」批准 `proposal.md` / `design.md` / `plan.md`
- [x] 批准前未修改 production/test code
