# RFC-250 独立设计门 · 2026-08-03

- 最终结论：**PASS — 0 P0 / 0 P1**
- 范围：`proposal.md`、`design.md`、`plan.md`，相关 RFC 与当前 production source
- 方法：两名独立只读 reviewer 分别负责产品范围/RFC 所有权与状态机/并发/可访问性；主审逐项修订后
  由原 reviewer 复核关闭
- 边界：这是设计批准前门，不是用户批准、实现门、提交或发布授权

## 1. 第一轮：Needs Attention

### 1.1 范围与所有权（6×P1）

| Finding | 证据 | 修订 |
| --- | --- | --- |
| `/repos` 被错误安排为 RFC-249 Done 后再修 | route 仍用 local tab；RFC-249 T31–T36 未闭合；RFC-198 要求 page tab URL 驱动 | RFC-250 不实现；`RFC-249 plan T31` 接收 strict `?tab=`、history/deep-link/query gating，并在 Done 前验证 |
| Intent 与 RFC-235 T5/T7 重复且完成条件矛盾 | RFC-235 已拥有 answers projector、unknown content、action gate；RFC-250 又列 AC/可条件跳过 | 从 RFC-250 production/AC 删除，新增 RFC-235 handoff note 与 plan 反链 |
| Tour 的 route/DOM outcome 无当前 attempt identity | 当前 provider 只有 `{tourId,stepIndex}`，route prefix/raw click 可被其它结果误触发 | 移交 RFC-211 follow-up，并定义 step-scoped attempt-bound receipt；RFC-250 不实现 |
| 第四条 Skill 路线未声明 supersede RFC-211 三卡决策 | RFC-211 顶部权威更正与当前实现均为三卡 | 删除第四路线；follow-up 明确三卡/四卡需用户重新选择与批准 |
| “Agent / 远程仓库”与现有中文基线冲突 | 当前一级导航与资源页主要使用“代理 / 远端仓库” | 降为本轮局部 key parity，沿用“代理 / 远端仓库 / 所有者”；全站 glossary 另议 |
| B1 先写 Dialog focus 红测、B2 才实现，B1 无法独立绿 | plan T5/T24 与每批全绿合同冲突 | T5 只保留 B1 dismiss/guard；focus 红测与实现同放 B2 T24/T33 |

### 1.2 技术状态机（5×P1、2×P2）

| Finding | 风险 | 修订 |
| --- | --- | --- |
| PAT 未处理 POST outcome unknown | 服务端可能已签发、客户端重试再造 token，首次 secret 永久丢失 | 复用 `classifyWriteOutcome`；增加 unknown phase、session reconciliation marker、inventory 检查/revoke、零自动重试 |
| Task draft 可能把 credentialed repo URL 写进 sessionStorage | userinfo/token 明文留在浏览器 storage | 专用 serializer allowlist；credential URL/secret input 只存 redacted metadata + reentry marker |
| Task pending 时继续编辑策略未裁决 | success 清草稿并导航会吞掉 submitted 后编辑 | 明确全部 material controls/step navigation 冻结；definitive failure 解冻，unknown 进入 reconciliation |
| Clarify 同题 PUT 可乱序 | gen N 迟到覆盖 N+1，两个 Promise 都 fulfilled 后仍假“已保存” | 每 question single-flight + queued latest；projector 比较 per-question ack generation；Save-and-leave 只承诺 IDB |
| Dialog Tab direction 会残留 | 正常 Tab 后的程序化 escape 被误当边界 wrap | direction token 绑定 source element，只活一个 key cycle；inside focus/redirect/keyup/pointer/blur 清除 |
| Canvas 阈值与 14px/11px 字体矛盾（P2） | 0.72/0.82 仍不可读 | 改为 topology `<0.55`、readable `>=1.10`，按 screen pixel 验收；补 hidden 0×0 settle、稳定 owner identity、用户 pan 不被 refetch 抢夺 |
| 测试缺并发/身份负向（P2） | 设计可被 happy path 假绿 | 补 body-read timeout、credential exclusion、Task unknown、PUT 乱序、direction 污染、camera threshold/hidden mount 测试 |

## 2. 复核轮残余与关闭

第二轮只剩三项：

1. Task `outcome-unknown` 已写设计但未进入 T/AC/test；现已进入 AC2、T11/T12 与组件负向矩阵。
2. RFC-249 只接收 URL tab、未接收 RepoGroupEditor residual dirty；现 T31 明确覆盖
   nodes/name/description、`newDirectory`、`pastedUrls`、`directoryNameDraft`，以及 ×/Esc/overlay/sidebar/
   Back、save pending 与失败保留。
3. hosted Ubuntu exact-SHA 与“未授权 push”矛盾；现拆为另获上库授权后的 publication closure。RFC-250
   implementation Done 只要求本地 Darwin visual；若用户要求上库，T46/hosted exact-SHA 才成为发布闭环门。

技术 reviewer 复核结论：**PASS，0 P0 / 0 P1**。范围 reviewer 复核结论：**PASS，0 P0 / 0 P1**。

## 3. 最终批准边界

RFC-250 可进入用户批准门；批准后只授权 RFC-250 自有 B1/B2/B3 scope 的 production 实施，不授权：

- RFC-235 Intent supporting contracts；
- RFC-211 Onboarding follow-up 或第四条 Skill 路线；
- RFC-249 production（它沿自己的既有批准与 T31–T36 关闭）；
- commit、push、PR 或发布。

实现完成后仍必须执行独立实现门；本报告不能替代实现证据。
