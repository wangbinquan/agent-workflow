# 原生用量消息 JSON 的资格查询

**当前决定：撤回本片查询优化，生产恢复完整原 LEFT JOIN 资格查询。** 两次独立实现复核分别发现比较左右列和额外会话过滤改变混合排序规则下的原关联范围。正式首报测量也没有证明整体提速。新增无引用／跨会话／NULL／坏消息回归保留，并补齐 Message NOCASE／Part BINARY 及反向组合的实际原范围错误与 ACK 前缀对照。以下设计仅保存已撤回候选的历史，不作为当前生产 SQL。

本片继续处理 RFC-371 首次完整报告的实际耗时。固定 137 个任务的 v188 报告发布仍为 13,117ms，原生读取阶段为 4,249.31ms；不是性能完成。工作区 Statement 复用后的 39,739 行、17,302 组计数、8,693 份凭据、57 个实际 EOF 页、Token 四桶及人民币估值均与 v179 完全一致。

## 原路径与问题

`opencodePartProjection.ts` 每次进入原会话时，先在同一原只读 SQLite 快照内判定全部 Part 和关联 Message JSON 是否可投影。当前查询先把每个 Part 与 Message 连接，再对 Message 文本调用 `json_valid`；一个 Message 被多个 Part 引用时，重复解析同一消息文本。资格通过才按原窗口投影，否则继续原范围查询和它的失败前缀。

三份真实原生根会话的只读查询计划已确认原 Part、Message 索引。独立 SQL 的资格结果均仍为 `null`，单次测量约 1.072→0.774ms、1.884→1.156ms、0.852→0.355ms。这些是原库诊断样本，不是正式报告提速证明，也不能代表所有根都已验证。

## 设计

只替换原 `read` 内的资格 SQL，不改投影字段、窗口、排序、ACK、指纹、四桶、原消息缓存、连接、事务、异常处理或原库索引。查询仍一次 `.get(session)`：

```sql
SELECT 1 AS unavailable WHERE
  EXISTS (SELECT 1 FROM part p
    WHERE p.session_id=?1 AND json_valid(p.data) IS NOT 1)
  OR EXISTS (SELECT 1 FROM message m
    WHERE m.session_id=?1 AND json_valid(m.data) IS NOT 1
      AND EXISTS (SELECT 1 FROM part p
        WHERE p.session_id=?1 AND m.id=p.message_id
          AND m.session_id=p.session_id))
```

第一分支覆盖原会话的每个 Part；第二分支按同一会话的 Message 判定，但只有实际被该会话 Part 引用的消息才使资格失败。两个关联比较都保留原 `m.id=p.message_id AND m.session_id=p.session_id` 的消息列在左侧，继承原列的排序规则；不得交换操作数或写死 BINARY／NOCASE。缺失消息、其它会话的消息以及无 Part 引用的坏消息不得使该会话失去资格。原查询的 NULL／非法 JSON 含义保持；任何准备或执行不确定仍被原 catch 捕获，沿原范围查询处理，不把失败改成 EOF。

## 实施与验收

先独立审查此设计，再改唯一 SQL，并沿现有 `rfc371-native-projection-fallback.test.ts`、`rfc371NativeProjectionFixture.ts` 的真实原库入口追加回归。覆盖无引用坏消息、跨会话消息、被引用的晚期坏消息，以及 Message 列 NOCASE、Part 引用 BINARY 的原关联。后一例先物理写入坏消息 Part `b`，后写入合法 Part `a`，比较实际原范围错误和零 Part ACK 前缀，避免错误预取先确认 `a`。原范围错误及 ACK 前缀与实际原范围查询对拍，合法数据的完整行、四桶、整体指纹和 EOF 与原标量 oracle 相同。真实批次／点查询计数区分正常投影与错误回退；原测试体、断言、预算及夹具不删、不减、不提高。

实现通过独立功能门后，用原 AW 服务和同一固定时间范围建立新报告，逐项对拍全部报告行、计数、原始采集凭据和全部分页事实。只报告实际测得的收益；没有任务、调用、消息或 Part 人口上限，也不把旧快速重入或 SQL 小样本写成首次加载完成。代码、配套登记和证据精确提交，hosted exact-SHA CI 另外签收。
