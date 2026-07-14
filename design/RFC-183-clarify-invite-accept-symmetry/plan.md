# RFC-183 任务分解

单 PR（改动面窄且强耦合，拆分反而制造中间态）；commit 前缀
`feat(clarify): RFC-183 反问「邀请⟺接受」对称收口`。

## 子任务

### RFC-183-T1 shared 类型层：`'delegated'` 入 ADT + 穷举分类器（零字节变化）

- `packages/shared/src/prompt.ts:159` directive 联合类型 + `'delegated'`；
  JSDoc 三处同步（`:125-143` / `:240-242` / `:258-260`）。
- 新增 `clarifyDispositionFor` 穷举分类器（design §2.1，P2#2）；渲染谓词
  `mandatoryAskBack` / `optionalAskBack` 改为消费分类器（字节零变化）。
- 测试：分类器全枚举单测；`rfc148-prompt-golden-matrix` / `rfc148-adt-contracts`
  case 表改由联合类型全体成员驱动（编译期完备性锚）+ 补 `'delegated'` 行，
  断言与 `'suppressed'` 输出逐字节相同（AC6）。
- 依赖：无。

### RFC-183-T2 backend 执行层：reject 处置收编 + host 改挂 `'delegated'` + 血统补丁

- `runner.ts`：派生改为消费分类器（`clarifyRejected`），RFC-123 stopped 分支收编进
  统一 reject 分支（stopped 措辞逐字节保留、suppressed 用新后缀，见 design §2.3）；
  新增 `kind:'none'` 前置拒（P2#3，`clarify-no-channel` 消息、无 failureCode）；
  改写 `:1219-1223` 失真注释。
- `scheduler.ts:782` → `directive: 'delegated'`（含 `:776`/`:703` 注释）。
- 血统补丁（design §2.5，P2#1+P2#4）：`nodeRunMint.ts` 新增纯函数
  `continuesClarifyLineage(causesNewestFirst)`（跳过 `process-retry`/`revival`，首个
  实质 cause 走 `isClarifyRerunCause`）；scheduler 以 `[当前 cause, ...sameNodeIterRuns
  cause（id 降序）]` 喂入并作为 oracle `isClarifyRerun` 入参；`isClarifyRerunCause`
  及其他调用方不动。
- 测试（同 commit，红→绿）：新建
  `packages/backend/tests/rfc183-clarify-invite-accept-symmetry.test.ts`，覆盖
  design §6 case 1-4（含 AC3b/AC3c 血统矩阵 + 未接线前置拒）+ 源码文本锁（case 6）；
  `continuesClarifyLineage` 纯函数五类输入单测。文件顶注写明锁的回归类型与本 RFC
  链接。
- 依赖：T1。

### RFC-183-T3 存量锁清点与门槛

- 全量 grep 测试源码中 `suppressed` / `clarify-forbidden` / `directive:` 锁
  （按 [feedback_grep_locks_before_push] 表级清点），对「suppressed 接受路径」的
  正向断言逐条改写并注明 RFC-183；`rfc148-adt-contracts.test.ts:148` cap 锁按
  design §6 改写。
- AC5 回归确认：`rfc181-autonomous-hardening` / `rfc164-workgroup-core|engine` /
  `rfc165-optional-clarify` / `rfc122-*` / `rfc123-*` 全绿（预期零改动）。
- 门槛：`bun run typecheck && bun run lint && bun run test && bun run format:check`
  + `bun run build:binary` smoke；push 后查 CI（按本人 sha 精确查询）。
- 收尾：`design/plan.md` RFC 索引状态 Draft → Done；`STATE.md` 顶部条目更新 +
  已完成表加行。
- 依赖：T2。

## 验收清单（对照 proposal §5，2026-07-14 落地核销）

- [x] AC1 评审重产出轮 self 反问被拒：failed + `clarify-forbidden`、零 session、不 park、
      followup 重索 output、耗尽硬失败（rfc183 A + rfc123 A 映射锁）
- [x] AC2 cross 同拒、不触发 answerer（rfc183 A）；AC2b 未接线前置拒（rfc183 C）
- [x] AC3 clarify-answer 续跑轮仍 mandatory；AC3b process-retry / AC3c revival 血统
      维持 mandatory（rfc183 D 纯函数+oracle 合成）
- [x] AC4 optional 评审轮不受影响（rfc165 全绿 + S3/S6 optional 迁移后的 prompt 断言）
- [x] AC5 工作组非自治照收 park / 自治 RFC-181 逐字节不变（rfc183 B + rfc164/rfc181 全绿）
- [x] AC6 prompt 字节零漂移（rfc148 golden matrix 零改动全绿 + 五 directive 等式锁）
- [x] AC7 host 派发源码文本锁（rfc183 E）
- [x] AC8 typecheck/lint/test（backend 5384 pass 0 fail）/format:check + build:binary
      smoke 全绿；shared 套件 3 处存量红已在干净 HEAD 复现属他人在途（CI 范围外）；
      CI 状态推送后按本人 sha 查验
- 附注：S3/S6 组合场景按新语义迁移为 RFC-165 optional 模式（suppressed 轮自愿反问的
  旧进入方式已被本 RFC 取缔），回归目标（approve 后不得重开评审）保持不变。
