# RFC-235 设计门前本地源码预审（2026-07-28）

> 本文件是设计门前的 source-backed preflight，不是 `CLAUDE.md` 要求的 Codex
> 设计门批准记录。生产代码仍须等 Codex 设计门收敛并得到用户批准后才能开始。
>
> 2026-07-29 更新：正式首轮门禁发现本预审遗漏的 8 个 P1、3 个 P2；本文件保留为历史证据，
> 不再代表当前设计。权威 finding/resolution 见
> [codex-design-gate-2026-07-29.md](./codex-design-gate-2026-07-29.md)。

## 1. 预审范围

- RFC 三件套：`proposal.md`、`design.md`、`plan.md`。
- 基线：`main@de3f2c4eaaaa28b4fcd7c6f6ae931ecd88d40d4f`。
- 当前前端：`routes/intent.tsx`、`routes/intent.detail.tsx`、Intent API/query、`Dialog`、
  `Stepper`、`ChoiceCards`、`ResourcePicker`、`Card`、`ClampedText`、i18n 与响应式样式。
- 当前 wire / 服务端：shared Intent schemas、Intent session/detail DTO、turn/mount-approval/
  commit routes、session/turn/apply 服务与 RFC-234 契约。
- 真实界面：`/intent` 与 session detail 的 1280px 桌面和 390×844 窄屏现状。

## 2. 已折入 RFC 的预审问题

| 风险面      | 本地发现                                                                                                    | 已折入的设计约束                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 创建入口    | URL `hint` 可为任意 string，控件显示 Auto 时 payload 仍可能发送原值；页面和空态重复 CTA                     | allowlist normalize + 单一 payload builder；inline Composer 为主入口，空态不再放第三个 CTA                             |
| 当前阶段    | `inFlight`、turn、draft、commit 可互相冲突；commit 查询没有顺序合同                                         | `deriveIntentJourneyState` 单一优先级；turn/commit 显式选最大 key，timeline 不改服务端顺序                             |
| 问题控件    | 当前所有问题都走短文本 `Segmented`，但 wire 允许多选和 512 字符选项                                         | 原生纵向 radio/checkbox choice rows；长文本换行；state 绑定 source turn                                                |
| 挂载审批    | endpoint 逐项挂载后才写 approval turn，批次不是原子/幂等；与 answers 串联时可部分成功                       | 先审批、refetch、按 concrete mount + source 后历史逐项核对，再提交 answers；未知结果不 replay 整批                     |
| 非幂等写    | create/message/answers/retry/rebase/mount/cancel 都没有 client mutation id                                  | 统一 attempt baseline + authoritative marker reconciliation；transport/5xx 不提供普通 Retry                            |
| Commit      | 现 UI 在 `mutationFn` 内生成 `clientMutationId`，响应丢失时可能形成第二次提交；secret 会参与 frozen request | 点击最终 Apply 前冻结 exact request/id；只以同一 id replay；secret 仅留当前页面内存，不进 cache/storage/URL/log        |
| stale 恢复  | `draft.stale` 与 `intent-baseline-stale` 名字接近但语义不同                                                 | 前者聚焦 Composer 生成新版；只有后者先 rebase，再生成新版                                                              |
| 权限        | detail DTO 允许 admin 审计他人会话，但当前 route 仍渲染多个写入口                                           | `isAuditView/canMutate/canStartSessionWrite/canAdvanceIntent` 单一 gate；archived/audit 负向 DOM 测试覆盖每类 mutation |
| 不可信 DTO  | turn content 与 draft changeset 进入 UI 前可能不是预期 shape                                                | 所有分支 safeParse；未知 answers/mount approval 不显示 raw JSON；invalid changeset 不进入 op/commit 控件               |
| 可达性      | 长草稿把 Review CTA 和 Stepper actions 推到折叠线下；移动 Dialog 易形成嵌套滚动                             | review action 紧随 summary，桌面 rail sticky、窄屏 normal flow；Commit Dialog 只让 Stepper body 滚动                   |
| 响应式/a11y | 通用表格和 section/card 堆叠在 390px 扫读困难，阶段只靠页面位置猜                                           | session link cards、1080px 双栏回落、语义 timeline/阶段轨、focus transfer、safe-area、axe/键盘/真浏览器矩阵            |

## 3. 当时的预审结论与纠正

- RFC 已从“换皮”收紧为一条完整且可恢复的
  `Describe → Generate → Clarify → Review → Apply → Continue` 体验。
- 当时判断“方案保持纯前端”；正式门禁证明该判断错误：generation launch、source-turn
  binding、mount batch、apply observability 与 archive/apply fence 都需要 backend/shared/
  migration 合同。当前 RFC 已改为 same-binary 协调交付，同时仍不放宽 RFC-234 的 ACL、OCC、
  secret、journal idempotency 或 all-or-nothing 语义。
- 本地预审发现的问题已进入 proposal AC、design 单一事实源和 plan 测试任务；本文件不作
  `APPROVED` 判定。
- 下一门：当前修订完成后在新隔离 snapshot 上复审全部 finding；通过后再请求用户批准实施。
