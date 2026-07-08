# RFC-152 · WS 频道双端注册表（proposal）

- **状态**：Draft（G3-G10 批量授权第 8 弹·收官，设计门后直接实现）
- **来源**：`design/flag-audit-2026-07-07.md` §5.4（RFC-G10）
- **前期调研**：单路全景（后端 server/broadcaster 散点计数、6+1 频道逐一鉴权形态、
  前端 6 hook 消费面、shared 现状、测试格局、迁移风险分级）。
- **P0 已先行修复**（682de313，bug 例外不等 RFC）：`/ws/memory-distill-jobs` 四处
  注释声明 admin-only 但 upgrade 从未 enforce——补 403 门禁 + 三格回归（此前该
  频道零测试覆盖，正是「7 处漏一即静默漏鉴权」的活体样本）。

## 1. 背景

新增一个 WS 频道今天要改 server.ts **5-7 处**（ConnectionData 判别臂/路径正则/
parseChannel/升级门禁/handleOpen 巨型 switch/safeSend 联合/tasks-list 特例）+
broadcaster.ts 3 处（常量/实例/reset）；鉴权是**三种异构形态**（task=升级时整
连接门禁+?since 回放、tasks-list·workflows·memories=per-frame 过滤含 admin 短路
与缓存/炸缓存/双码路差异、repo-import·distill-jobs=仅 token）——handleOpen 里
三段近似复制的「admin 短路+缓存+出错丢帧」块。前端 6 个 hook 各写一份
`msg.type===` if 链；消息**形状**已由 shared/schemas/ws.ts 单源，但事件 type
字面量与 path 串双端手写；reviews.detail 同 task 双挂 useTaskSync 两条连接。

## 2. 目标

1. **PR-1 ChannelSpec 注册表**（backend ws/registry.ts）：
   `{pathRe, parse, helloName, broadcaster, upgradeGate?, frameGate?,
frameGateCached?, adminShortCircuit?, cacheBustOn?, onOpenExtra?}` +
   `gatedSubscribe()` 高阶函数统一三段复制块；**纯新增不迁移**（绿灯不变）。
2. **PR-2 低风险频道迁移**：repo-import、memory-distill-jobs（仅 token/admin 门禁
   ——P0 修复语义原样入表）。
3. **PR-3 per-frame 家族迁移**：tasks-list、workflows（炸缓存+删除旧缓存特例）、
   memories（scope 双码路）——rfc099-ws-acl-filter 逐帧锁零改动为判据。
4. **PR-4 task 频道迁移**（最险压轴）：整连接门禁+?since 回放走
   upgradeGate/onOpenExtra 逃生舱；生产者 ~18 点 7 文件不动（broadcast 调用面
   零改动）；ws.test 回放锁零改动；**迁移前补 stranger-task 帧级拒绝测试**
   （现仅升级 403 覆盖）。
5. **PR-5 前端 invalidation 表**：`INVALIDATION_RULES: Record<type,(msg,ctx)=>
QueryKey[]>` + `useWsInvalidation(path, rules)`；6 hook 收敛；顺带 socket 复用
   消 reviews.detail 双挂；shared 补频道 path 常量（双端手写清零）。

## 3. 非目标

- 不动消息 schema（shared/schemas/ws.ts 已单源）；不改 wire。
- 三种鉴权形态**不拍平**（RFC-147 先例：registry expresses both, does not
  flatten）——spec 以可选槽表达，task 的回放/多路复用语义走逃生舱。
- clarify 不拆独立频道（复用 task 频道现状保留）。
- repo-import 的 batch 归属校验不加（ULID 不可猜、产品未要求——登记遗留）。

## 4. 验收标准

1. 注册表 satisfies 全频道穷举 + 新增频道改动面 = spec 1 行 + broadcaster 1 实例
   （grep 棘轮锁 server.ts 无散装频道分支残留）。
2. 逐帧对拍锁（ws/rfc099-acl/repo-imports/auth-multi-token 群）**零改动全绿**；
   task 频道新增 stranger 帧级拒绝格。
3. 前端 6 hook 收敛 + 双挂消除；invalidation 表单测。
4. 门禁 + CI conclusion=success + Codex 双门收敛。
