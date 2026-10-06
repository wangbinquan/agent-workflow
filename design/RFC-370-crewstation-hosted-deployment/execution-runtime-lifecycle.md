# RFC-370：执行后台生命周期与 provider 切换分离

状态：阶段 A 的 H7 子单元；独立设计门 D1 已通过，源码候选已写入，待独立实现门、matching census、发布及 exact-SHA hosted CI。用户已批准 RFC-370 的实现与上库。本单元不包含 CS adapter，不关闭 H7／A-G，不记 aw 已部署到 CS。

## 问题与现有边界

`cli/daemonProviderRuntimeSession.ts` 已有完整的可重试运行时生命周期：顺序启动 runtime factories，再启动 background writers；暂停先关闭 HTTP／WS，再逆序发出全部 stop，最后逆序等待全部 drain。成功 stop／drain 的阶段不重复；失败阶段保留，关闭时先排空再依次完成 close participants、identity、provider。原错误对象、AggregateError 和串行尾队列都有实际回归。

两个 daemon 根各有 5 个 runtime factory 和 14 个 background writer，具体排列不同；本单元保留原排列、原对象、原 start／stop／drain 与关闭参与者。现有数据库 provider 切换确实需要关闭业务 HTTP／WS。CS 执行权待命或丢失则需要另外暂停派发与后台效果，使资源读取／编辑仍能使用同一 provider。用现 `pause()` 代替执行暂停会把控制面一并关闭。

## 所属层次与交付边界

system-operations 在 `application/ports/daemonExecutionRuntime.ts` 拥有窄 `DaemonExecutionRuntimeControl` 合同，由 exact `composition/daemonExecutionRuntime.ts` type-only 导出给 bootstrap。合同只表达本 provider generation 的执行后台启用意图、当前 handle 和可逆 pause／resume，不包含 PID、路径、Bun、CS fence 或 CS wire DTO。

具体 provider handle 和已组合 HTTP／WS 的所有权继续属于现 bootstrap session。新增接线直接复用该 session 唯一的串行队列、start 循环和 stop／drain 循环；不建立第二份 handle registry，不重复实现 worker 算法。后续 system-operations 执行权协调器消费此端口。旧 CLI exports、旧 provider 生命周期与 `state()` 返回结构保持兼容；新的执行投影单独挂在 `session.execution`。

本片只交付可逆的后台执行生命周期。真正的执行请求 admission、claim／renew／activate、租约过期、受控事务排空、启动恢复、handoff／migration 与恢复五动作仍是 H7 的必做项。特别是现 `webhookTerminalControl.reconcileOnBoot()` 会在 session resume 之前启动 worker；本片不据此声称所有执行效果已受新端口控制。H7 收口必须将两根的早期恢复和该 worker 接到执行权启动阶段，并按有效 authority 恢复，而非让待命实例做 standalone 全量回收。

## 合同与状态规则

作用域保持原 `operationId`、`provider`、`generationId` 三字段。provider generation 校验继续调用原 session 校验并保留原错误 constructor／code。新的执行投影为 `enabled`、`running` 和 `activeHandleIds`；每次读取返回冻结对象与冻结列表。`enabled` 表示本 session 被请求允许执行后台，`running` 只在 provider 已运行、执行启用且已启动的完整 handle 集合有效时成立。

1. 初始 `enabled=true`，保持原 standalone 行为。provider 初始仍 frozen，仍先执行原两项 admission close；没有新的 factory、探针、计时器或恢复动作。
2. `execution.pause(scope)` 与原 provider 操作使用同一串行尾队列。先校验原 generation 和未 closing／closed，再将 `enabled=false`，逆序 stop 全部已启动 handle，再逆序 drain；保留失败阶段以便原样重试。该操作不调用 provider HTTP／WS admission，不调用 close participants、identity 或 provider close。
3. 当 provider 已 running，`execution.resume(scope)` 先结清同一执行集合的残留 stop／drain，之后仅按原顺序启动原 factories。重复 resume 不重复启动。失败时按原逆序 stop／drain 回滚，`enabled=false`，保留原错误及回滚错误；HTTP／WS 的现有 admission 不变。
4. 当 provider 为 frozen，`execution.resume(scope)` 仅记录 `enabled=true`，不启动 handle。之后原 provider `resume(scope)` 才能启动。这样执行 resume 不能越过数据库切换的暂停边界。
5. 原 provider `resume(scope)` 对默认 `enabled=true` 保持原 start → WS open → writer open 顺序与全部失败处理；若显式 disabled，只跳过执行 handle 启动，仍按原顺序打开 WS／HTTP，使已组合控制面可用。原 provider `state()` 的 phase 仍描述 provider 生命周期，不用它表示执行权。
6. 原 provider pause／close 总会停止并排空所有残留 handle，与 enabled 无关；不会把已经执行暂停的 session 改回 enabled。provider rollback resume 也保持显式 disabled，不擅自恢复后台。
7. provider close 的七个原关闭参与者、identity、provider 的顺序和重试进度不变。执行权丢失后的 shutdown 写入资格需要后续 authority 协调器和各 owner 的关闭合同解决，本片不将保留的 standalone close 行为当作已实现该功能。

两个 resume 路径共享唯一启动 helper；原 provider resume 失败仍执行完整 provider freeze，而单独执行 resume 失败只处理执行 handle。默认 native 路径的条件分支、原 callbacks、getter 读取时点、返回对象与原 reader 不变；新增启用意图与执行投影只供明确使用新端口的消费者观察。

## 功能回归与验证

保留 `rfc349-daemon-provider-runtime-session.test.ts` 全部原名称、断言和预算，也保留 router、bootstrap、shutdown、handover 和原 runtime-handle 回归，不为新接口改写或弱化旧状态 oracle。新功能测试至少覆盖：

- 已 running 的暂停只逆序 stop／drain，HTTP fetch 与 WS delegates 仍可用；无 close participant／identity／provider close 调用。
- provider 初始 frozen 时执行 pause，之后 provider resume 不启动任何 handle，但打开原控制面；显式执行 resume 再按原顺序启动一次。
- provider pause／rollback resume 保持 disabled；frozen 状态执行 resume 不提前开 worker。
- 重复与并发执行 pause／resume／provider close 共用串行队列；没有重复 start、stop 或 drain。
- 部分 start、stop、drain 失败保留具体对象和完成进度；重试只补未完成阶段；执行 resume 失败的回滚不会关闭控制面。
- 不同 provider generation 与 closing／closed 拒绝仍用原错误对象和 code。
- 两个原 root 的 5+14 ordered factory 列表与七个 close participant 全文不变，原默认 native 生命周期事件序列不变。

Windows push／PR 触发路径和实际 suite 对称补齐新合同、装配导出、新功能测试及现 runtime session；保留原 workflow 全文与既有 suite。只对自有文件做 format／lint 与纯 AST／字节／JSON 对拍，匹配架构清单按最终生产候选执行一次原 scoped census，原规则与分类器不改。实际测试、双 provider／OS 与构建结论交新提交 exact-SHA hosted CI，不运行本机 AW tests／typecheck／build／service。

## 后续顺序

本片设计门 → 源码及新回归 → 独立实现门 → 一次 matching census／元数据门 → 精确上库及 hosted CI。随后完成 authority 协调器、启动恢复／早期 worker 与执行 admission、剩余 purpose 命令及真实根选择，独立 A-G 后才编写各 owner 的 CS adapter。阶段 B 仍先 M0 必须适配与实际部署／持久性验收，再增量 M1～M4。

## D1 与当前源码候选

D1 为 PASS、0 findings；15 项（1 owned／14 control）首末完整读取均为 496703 bytes，FP 为 `8f1731bb2300ca7f801ca23b5fe65681eb3544bada520a65ba3b20a86ab08e5f`。独立回执 45834 bytes、SHA256 `b5e0b28d0a5ba7574762fa5b9e7370521c6f27714d130844b96260a029155b16`。该结论只覆盖上述设计，不代表实际运行验收。

当前源码复用原 session 的唯一队列、handle registry 和原 stop／drain 进度；原 start 循环移入一个 helper，由两个 resume 路径共享。原 provider pause／close 和 admission 逻辑继续保持，新的 execution 投影独立冻结，不扩张原 provider state 结构。

新增回归按两种 provider 各定义 9 个功能场景，共 18 个运行案例；覆盖控制面保留、frozen 意图、provider 失败恢复、部分启动、stop／drain ACK、回滚与残留失败、并发、关闭与 generation 错误，以及空 factory 集合。原六份生命周期回归全文不改。Windows push／PR 对称新增 5 个路径和 2 个实际 suites，保留原所有路径与 suites。实际测试尚待新提交的 hosted CI。
