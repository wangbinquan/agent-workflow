# RFC-301 任务启动来源归一与筛选补全

状态：**Done（2026-08-14）**

## 1. 背景

任务列表的「筛选任务」弹窗已有启动来源筛选，但当前只提供「全部 / 手动 / 定时」三项。后端也
只有一条推断规则：`scheduled_task_id IS NULL` 就算手动，否则算定时。

这会把两类已经存在的生产入口错误归进「手动」：

- Webhook 触发规则启动的任务；
- 使用 PAT 或 daemon token 直接调用任务启动 API 的任务。

同时，workflow/workgroup 的 call 节点会创建子任务。若只看当前任务的局部字段，子任务会被归成
另一种来源；用户按「Webhook」或「定时」筛选时，就无法看到同一棵任务树的完整执行链。

本 RFC 把启动来源从查询时猜测改成创建时确定、持久化且对子任务继承的领域属性，并在现有筛选
弹窗补齐「Webhook / API」。

## 2. 用户已确认的产品规则

### D1. 筛选项固定为五项

筛选弹窗按以下顺序显示：

1. 全部来源
2. 手动启动
3. 定时启动
4. Webhook 触发
5. API 启动

`all` 只是查询选项；持久化的真实来源只有 `manual | scheduled | webhook | api`。

### D2. API 按可信认证来源判定

- 通过登录会话（`ActorSource = session`）直接发起的根任务记为 `manual`；
- 通过 PAT 或 daemon token（`ActorSource = pat | daemon`）直接发起的根任务记为 `api`；
- 判定只使用服务端认证结果，不接受 request body、query 或自定义 header 指定来源。

因此，脚本即使使用登录会话 token 调同一 HTTP endpoint，仍属于 `manual`；浏览器或命令行不是
判据，可信认证通道才是判据。

### D3. 业务触发器优先于认证来源

Scheduled 与 Webhook 启动都可能由 daemon actor 执行，但必须分别记为 `scheduled` 与
`webhook`，不能因 daemon token 被归成 `api`。来源优先级是业务 invoker，而不是执行请求所携带
的技术身份。

### D4. 子任务继承整棵树的根来源

workflow/workgroup call 节点创建的子任务不新增第五种「节点调用」来源。每一层子任务都继承父任务
已经冻结的 `launchOrigin`，所以整棵树始终属于同一个筛选分组。

### D5. 历史数据尽力回填，不伪造 API 归属

- 有 Scheduled / Webhook 持久证据的历史根任务按证据回填；
- 已有任务树从根向全部后代传播根来源；
- 历史直接 API 与登录会话启动在现有数据中不可区分，均保留为 `manual`；
- 不根据时间、owner、审计日志或 token 猜测 API 来源。

### D6. 本次只补筛选，不新增列表或详情标签

任务列表返回结构、任务详情结构与现有 Scheduled/Webhook 来源链接保持不变。本 RFC 不在任务行或
详情页再展示来源 badge，也不暴露内部 `launchOrigin` 字段；筛选 query 是唯一新增用户可见能力。

## 3. 目标

1. 用户能分别筛选手动、定时、Webhook 与 API 启动的任务。
2. 来源在根任务创建时由可信上下文一次确定，不再由查询层反推。
3. 同一任务树的所有后代继承根来源，筛选结果不拆散执行链。
4. Scheduled、Webhook、HTTP 任务路由与 Fusion 等直接启动路径使用同一来源判定规则。
5. 历史数据迁移确定、可解释、可重复验证，不把未知历史包装成精确结论。

## 4. 非目标

- 不新增「节点调用」「恢复」「重试」「Fusion」等来源类别。
- 不按 endpoint、客户端 User-Agent、浏览器/CLI 或请求载荷细分来源。
- 不回查 GitHub/GitLab，也不从 Webhook 原始 body 动态计算筛选结果。
- 不重做筛选 Dialog、`Segmented`、任务树、分页或 facet UI。
- 不改变谁有权启动、读取、筛选任务，也不改变 PAT/session/daemon 的认证能力。
- 不把来源字段开放为 create/update API 参数，不提供修改已落库来源的 endpoint。

## 5. 用户故事

1. **Webhook 排障**：管理员选择「Webhook 触发」，能看到 webhook 根任务及它调用出的所有子任务。
2. **API 用量检查**：管理员选择「API 启动」，只看到 PAT/daemon-token 直接启动的任务树，不混入
   登录会话手动启动。
3. **定时任务复盘**：选择「定时启动」后，定时根任务的 workflow/workgroup 子调用仍完整可见。
4. **普通人工操作**：在登录态页面直接启动任务继续归入「手动启动」，现有用法不变。
5. **历史筛选**：迁移后的 Scheduled/Webhook 历史树可正确筛选；无法证明的老 API 启动明确留在
   手动组，不制造虚假精度。

## 6. 验收标准

- [x] shared 查询契约支持 `all | manual | scheduled | webhook | api`，未知值继续拒绝。
- [x] 筛选弹窗中英文都按 D1 显示五项，并继续复用共享 `Segmented`。
- [x] session 直接启动记为 manual，PAT/daemon-token 直接启动记为 API；客户端不能伪造来源。
- [x] scheduled/webhook invoker 分别覆盖 actor source，Fusion 的创建与驳回后重启也按 actor source
      正确归类。
- [x] call-workflow/call-workgroup 的一层、多层子任务均在父任务创建事务内继承根来源。
- [x] 后端筛选只比较持久化 `launch_origin`，不再以 `scheduled_task_id IS NULL` 推断 manual。
- [x] 迁移正确回填 Scheduled/Webhook 根与后代；历史不可判定 API 保留 manual；循环/悬空异常行不会
      让迁移失控。
- [x] `launch_origin` 不进入任务 create/update wire，也不新增 Task/TaskSummary/TaskOperations 响应字段。
- [x] 390px 下五项不造成页面级横向溢出，触控、内部横向滚动与键盘选择均可达。
- [x] 正常、非法元数据、历史回填、多层继承、并发创建、筛选分页、回滚兼容与真实
      daemon/API/browser E2E 均有防护。
- [x] 定向测试、迁移/rolling upgrade 测试、前端、E2E 与 `bun run gate:local` 全绿；实现门 findings
      全部处置。

## 7. 能力影响清单

### C1. 被关闭或收缩的既有能力：无

本 RFC 不关闭任何任务启动、筛选、读取、认证或恢复能力，不改变 endpoint、权限、默认筛选、任务响应
结构，也不删除旧的 manual/scheduled 查询值。Webhook/API 只是新增可选筛选值。

### C2. 受影响的部署形态

- **正常单版本部署**：数据库升级后，四类新任务获得精确来源；旧客户端不选择新枚举时行为不变。
- **短暂混合版本/代码回滚部署**：新列带 `manual` 默认值，旧 writer 不会因缺字段而失败；它创建的
  Scheduled、Webhook、API 根会降级为 manual。数据库的 child-inherit trigger 仍强制后代继承父来源，
  因此新代码创建的精确根不会因旧 binary 恢复后再建 child 而被拆树。
- **已有历史库**：Scheduled/Webhook 及其任务树按持久证据回填；不可证明的历史 API 仍为 manual。
- **外部 API/MCP 客户端**：请求和响应 schema 不增加来源字段；只有列表 query 的允许枚举向后兼容扩展。

字段一旦落库即为不可变来源事实。回滚只回退新代码，不删除列或重写历史；旧版本仍能读取数据库，
只是把新增筛选能力降级为原有表现。没有需要用户逐项接受的 breaking capability removal。
