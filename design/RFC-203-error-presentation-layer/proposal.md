# RFC-203 错误呈现统一层（proposal）

- 状态：Draft（待用户批准）
- 来源：[全仓 UX/功能/错误呈现审计（2026-07-16）](../ux-functional-audit-2026-07-16.md) §1 R1（错误码映射覆盖率）+ R3（内部标识直出）+ R6（后端给了前端丢了）；审计修复路线 RFC-A
- 关联：RFC-145（failure_code 机读失败码）、RFC-202（详情 details 就地渲染的两处先例）

## 1. 背景

审计确认「报错看不懂」是全站最大的体验短板，且 2026-07-17 全量盘点显示问题比审计估计更大：

- 后端 **399 个错误码**，前端 `errors` 词典只映射 **21 个（5.3%）**——其余全部落到「请求失败: \<英文开发者原文\>」。repo/git 域 68 码、auth 域 33 码、skill 域 28 码等**整域零映射**。
- 另有两个隐藏码层完全在映射体系之外：~13 个绕过 DomainError 构造器的 wire 码；**84 个工作流校验 issue 码**（装在 `workflow-invalid` 的 `details.issues[]` 里，校验面板整段英文透传的根源）。
- 后端为 UX 准备的 **247 处 `details` 载荷**（9 种形状：zod issues / referencedBy / availableRefs / stderr / scheduledTaskIds / OCC 版本对 / 权限对 / taskIds / 定位键）在前端几乎零消费——规范入口 `describeApiError` 根本不读 details、不支持插值。
- 呈现层被三类分叉稀释：**6 处字节级相同的私有 `describeError`**（输出裸 `code: message`）；**22 处裸 `.error-box`** 绕过 ErrorBanner；code→key+details 插值逻辑在 TaskQuestionList / workflows.edit / describeRecoveryKind 三处各写一份。
- fetch 网络错误（`TypeError`）未归一成 ApiError——「Failed to fetch」英文直出的根因。
- RFC-145 的 `failure_code` 机读失败码（7 值）止步后端：`NodeRunSchema` 无此字段、前端零消费，任务失败横幅只能透传英文机器串（审计 P1 F-2）。

## 2. 目标

1. **单一错误解析器**：`resolveApiError(err)` 返回结构化 `{ title, detail?, hint?, details? }`——精确映射（code→词条）→ 域级兜底（前缀→域模板）→ 全局兜底三级降级；支持插值；把网络错误 / 非 JSON 响应 / WS 嵌套体全部归一。
2. **ErrorBanner 富渲染**：已知 details 形状（zod issues、referencedBy、availableRefs、scheduledTaskIds、OCC 版本对、stderr 折叠）由 ErrorBanner 自动渲染，调用方零代码受益；原始英文 message 降级进「详情」折叠而不是当标题。
3. **词条分层补齐**：
   - L1 精确：高频用户可触发码（任务发起/git/上传/评审/反问/生命周期/删除引用等，目标 ≥150 码）每码「发生了什么 + 下一步」双语文案；
   - L2 域级：19 个域各一条兜底模板（如 repo 域「仓库操作失败」），未精确映射的码不再裸奔英文；
   - L3 全局：`fallback` 不再拼接英文原文（原文进折叠详情）。
   - 84 个校验 issue 码：常见 ~40 个精确 + 前缀族兜底，校验面板从整段英文变成中文可读。
4. **failureCode 通到前端**：NodeRunSchema + getTaskNodeRuns 透出 `failureCode`；7 值全部中文映射；任务失败横幅优先展示映射文案 + 下一步指引，errorSummary 机器令牌（snapshot-lost / node-timeout / scheduler error 等）建 describeRecoveryKind 同款影射表，未知令牌回退原文折叠。
5. **分叉清零**：6 处私有 describeError 全部替换为统一层；22 处裸 `.error-box` 迁 ErrorBanner；TaskQuestionList / workflows.edit / describeRecoveryKind 三个手写模式改为统一层的局部覆盖入口（保留其语义）。
6. **非统一错误体收敛**：`tasks.ts:308` 的 `{error:string}`、plantuml 三处、ws/server 嵌套体与纯文本 426，全部改统一 `{ok:false, code, message, details?}`。

## 3. 非目标

- **全局 MutationCache.onError 兜底与 toast 原语**——那是"静默失败清零"（审计路线 RFC-B）的主体，本 RFC 只修"错误被显示时显示得好不好"，不新增"错误没被显示"场景的捕获面。
- 后端 `message` 英文开发者文案不动（面向日志与 API 消费者；本地化只发生在前端层）。
- 校验错误的画布点击定位（RFC-199 校验可视化域，已有 `workflow-validation-target` 基础）。
- 收件箱条目内部名（`__wg_clarify__` 等保留名→展示名映射）——属展示名域，随后续批次。
- 多人并发竞态类问题。

## 4. 用户故事

- **S1**：我把仓库 URL 拼错了点「启动」，看到的是「无法克隆仓库——请检查仓库地址与访问凭据」+ 可折叠的 git 原文，而不是「请求失败: git clone failed for ...: fatal: ...」。
- **S2**：我填的分支不存在，报错直接列出当前远端的可用分支（后端本来就算好了 availableRefs）。
- **S3**：我删除一个被引用的 agent，报错列出引用它的工作流名单（referencedBy），而不是一句英文。
- **S4**：任务因 agent 没按协议输出而失败，横幅写「代理未按约定格式输出结果，已自动重试仍失败——可点击继续任务重试该节点」，而不是 `envelope-missing: no <workflow-output> envelope found in stdout`。
- **S5**：工作流校验面板列出的是「循环包装器缺少退出条件（节点 loop_x）」这类中文行，而不是英文图论长句。
- **S6**：daemon 没起时打开页面，看到「无法连接到服务——请确认 daemon 正在运行」，而不是「Failed to fetch」。

## 5. 验收标准

- A1 `resolveApiError` 单元覆盖三级降级、插值、网络归一、WS 嵌套体、非 JSON；`describeApiError` 保留为薄壳（返回 title）保证存量调用方为兼容。
- A2 ErrorBanner 对 6 种已知 details 形状的富渲染各有测试；未知形状不炸、原文折叠。
- A3 词条：L1 ≥150 码 + L2 全部 19 域 + 校验 issue 码 ≥40 精确，zh/en 双语齐；孤儿键清理（skill-source-\* 5 个）；CI 加「新错误码必须至少有域级兜底」的源码锁（可选）。
- A4 failureCode 端到端：DTO 透出 + 7 值映射 + 失败横幅优先级测试；errorSummary 影射表 ≥12 个已知令牌。
- A5 私有 describeError 0 处残留（源码锁）；裸 `.error-box` ≤ 保留白名单（ErrorBanner 自身），迁移面回归测试。
- A6 非统一错误体路由全部返回统一体（含 ws upgrade 拒绝），路由测试锁定。
- A7 `bun run typecheck && bun run test && bun run format:check` + 前端 vitest 全绿；涉及 shared schema 的 binary smoke。
