# 同一原生事务内按实际 Message 行校验 JSON

## 问题和证据

完整首次报告仍为 13.117 秒，不能记作性能验收通过。Part 投影原资格查询把同一 Message JSON 按关联 Part 数重复解析。2026-10-11 的原库只读诊断完整读取原报告 `d447ab61-e9aa-4429-8faf-b5a836cb8693` 的 8,693 份收据，遍历所有 2,315 个引用根及子会话：481 个引用已不存在，实际可达 1,852 个会话无上限。两种资格 SQL 各跑一次，同一原生只读事务内结果逐会话精确相等。原查询 1,772.294 ms；候选按实际 Message 行去重后 265.318 ms。

该诊断使用 Python SQLite 3.37.2，不能替代 Bun 产品、正式报告、CI 或错误前缀回归。原失败和撤回的两种资格查询仍保留。未重新运行本地 Bun 测试，没有改原数据。

## 有限优化

原 Part 资格条件仍为 `p.session_id=?1`，原 JOIN 的左右列顺序逐字保持：`m.id=p.message_id AND m.session_id=p.session_id`。分别检测全部所选 Part 的 `json_valid(p.data)`，以及此原 JOIN 实际匹配的 Message 物理 `_rowid_`；在 JSON 校验前只对这些物理行标识去重。

不可按 Message session 再加筛选、反转 JOIN、按 role 筛选或对 raw JSON 文本去重。前两者会改变列的 NOCASE/BINARY 比较；最后一种会在 data 列使用 NOCASE 时混同有效 `true` 与无效 `TRUE`。原 range/point/prefetch 字段、排序和失败前缀均不改。

第一次 Part 读取时（原 `BEGIN` 与原根读取之后）探测原连接的 `PRAGMA table_list` 和 `PRAGMA main.table_xinfo(message)`。仅在确定所解析的 Message 是 main 中唯一的普通 rowid table、`wr=0`、且没有大小写无关的 `_rowid_` 声明列时使用物理行查询。探测结果只在这一原连接/事务内复用；不能在 factory 构造或 `BEGIN` 前探测。

原资格 SQL、物理 Message 资格 SQL 和探测函数均置于原 reader factory 内部；首次实际读取才探测，不新增顶层符号或调整架构库存守卫。

元数据缺失、类型不符、PRAGMA 不支持、view、virtual table、WITHOUT ROWID、同名 TEMP 对象或 `_rowid_` 声明列一律使用原资格 SQL。优化查询失败时继续保持原 range 读取，不填写零值，不吞掉原错误。所有 JSON 不合格路径保留原 range/point 查询的完整前缀、错误、原 ACK、计数、指纹和 EOF。

## 验证和发布条件

保留现有 Message/Part 两个方向的 NOCASE 错误前缀、未引用 malformed/NULL Message、referenced malformed/NULL、optional-prefetch 失败/丢行/重复/重排、字节与行预算、旧末页和旧 ACK 回归。补充普通物理 Message 去重的实际原结果、NOCASE data 不得去重文本、WITHOUT ROWID/view/virtual/shadow/TEMP/PRAGMA 失败的原查询回退，及元数据只在原事务内探测一次的回归。

有限设计门和实现门分别核对；元数据生成来自本次真实源码完整普查，不调高守卫或账本。按 AW 要求只用 hosted exact-SHA CI。正式原服务生成同一窗口的完整报告后，完整比较全部行、计数和收据（只规范化报告自身随机标识）；四桶 Token、人民币估值、全任务/调用/引用人口及所有 EOF 精确保持，才可记录正式性能变化。若正式收益不足，不声称首屏性能已经达标。

## 2026-10-11 TEMP 夹具的实际生命周期修复

已发布 `16ba8f3668301e5a6afaf10616f25d871b2f6740` 的自动 Windows CI `38132049380` 在 `rfc371-native-projection-fallback.test.ts:659` 失败：TEMP 分支完整 EOF 和 step ID 已通过，但实际执行了物理 Message 资格查询。其余八种不支持的 shape/metadata 回退通过。原失败日志保留于 `/private/tmp/aw-rfc370-provenance-ci-16ba8f366-windows-failed-steps-r1.log`，424,779B，SHA256 `6d587c57c897cdebb44e39f6368e21bffc989b5b0e586be372bc709a0db793c0`；该次 CI 保持 failure。

夹具曾在原连接刚打开时创建 TEMP Message，随后真实 reader 设置 `PRAGMA temp_store=FILE`。SQLite 在改变此设置时会立即删除已有 TEMP 对象，因此资格探测时 TEMP Message 已不存在。[SQLite 原始说明](https://www.sqlite.org/pragma.html#pragma_temp_store) 支持这一生命周期判断。修复把真实 TEMP Message 的创建放到该原 PRAGMA 执行完成之后，并新增实际 `PRAGMA table_list` 必须同时含 main/temp Message、两表完整行值必须相等的断言。原主库保持只读，原资格 SQL、完整 EOF、step IDs、物理查询禁止断言、原回退查询次数和包预算全部保留。没有修改生产探测、提高超时或跳过用例；本机不运行 AW 测试，修复由新的 exact-SHA CI 核对。
