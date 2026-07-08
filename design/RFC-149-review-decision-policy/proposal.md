# RFC-149 · review 决策策略表 + 前端历史视图收敛（proposal）

- **状态**：Draft（G3-G10 批量授权第 5 弹，设计门后直接实现）
- **来源**：`design/flag-audit-2026-07-07.md` §5.2（RFC-G7）
- **前期调研**：两路 fan-out（backend review.ts 决策分支全景 / 前端只读视图与交叉锁），
  行号以调研实测为准。**audit 修正**：`args.decision` 驱动的正交维实测 **≥13**（audit 记
  8——漏 decisionReason 派生、广播实参、buildReviewPromptContext 二次分支、multi-doc
  approve gate、approval_meta 字面量）；分散在 3 个函数 + 2 处「数据形状旁路 kind
  oracle」病灶。前端 3 份色映射已被 W0 收口成 DECISION_CHIP_KIND 单表（本 RFC 不重做）。

## 1. 背景

1. **backend**：`submitReviewDecision`（review.ts:1779-2180）内 decision 一个字符串驱动
   ≥13 个正交策略维；approved 早返回造成维 3-7 稀疏；reject/iterate 键名对
   （rerunnableOnReject/OnIterate、rollbackFilesOnReject→true/OnIterate→false）不对称；
   `buildReviewPromptContext`（:2481-2525）对同一 decision 第五次分岔。
2. **轮模式双推导**：dispatch 侧按上游端口 kind（:436/:447）、decision 侧按数据形状
   NULL sentinel 重推（:1827/:1720），两层×两侧=4 处判定零共享。
3. **decidedBy 四态魔法串**（null/'local'/'system'/ULID）：审计列兼职流程判据
   （ne(decidedBy,'system') :2466/:2491 直接决定 iterate 重跑 prompt 取哪行——
   :2450-2458 注释记载过选错行 bug）。
4. **发布口旁路 oracle**：'approved_doc'(:1945)/'accepted'(:1751) 字面量按数据形状硬选，
   `reviewApprovedPortName` oracle 只在声明侧（nodePorts）被用——同名真理两条推导路径。
5. **前端**：单文档 `resolveReviewView` resolver 之外仍有 12 个逐字段三元 + 11 处
   readonly 守卫；多文档未沿用 resolver、就地 sentinel 链（undefined/-1/null 三种编码）
   且 readonly 恒 =!awaiting 塌缩掉「当前但已决策」第三态；`ReviewDocPane` 的
   (readonly, awaiting) 布尔对非法组合仅靠调用点隐式防御。

## 2. 目标

1. **REVIEW_DECISION_POLICY 策略表**（backend 局部，satisfies 穷举 3 决策值）：
   bumpsIteration / lifecycleEvent / decisionReason 派生 / rerun-rollback 键名对
   （approved 稀疏=可选槽）/ supersede 列值 / mintCause / cascade 语义 / promptCtx
   构造器——submitReviewDecision 与 buildReviewPromptContext 的 decision 分支全部查表；
   新决策 = 表加一行（+ shared 枚举 + 前端 chip/i18n 表行，Record 缺键编译红）。
2. **轮模式单一真源**：`resolveReviewRoundMode(dvs): 'single'|'multi-inline'|'multi-path'`
   ——decision 侧 4 处 NULL-sentinel 判定收敛为一个 helper（dispatch 侧 kind 推导保留，
   它是模式的生产者；本步只消 decision 侧的重推分叉）。
3. **decidedBy 最小治理**：SYSTEM_DECIDER/'local' 常量 + `isSystemDecision()` 谓词，
   4 写点 3 读点字面量清零；`decided_by_kind` 列列为非目标（治本待产品需要）。
4. **发布口走 oracle 常量**：reviewApprovedPortName 的两个返回值导出为常量，
   review.ts 两处字面量与 approval_meta 的 'approved' 改引。
5. **前端收敛**（独立 PR）：`resolveRoundView`（多文档 resolver，与 resolveReviewView
   同形）+ `viewedVersion` 一次挑齐对象（12+5 逐字段三元清零）+
   `mode:'awaiting'|'decided'|'historical'` 单 variant prop（ReviewDocPane 布尔对
   非法态不可表示；多文档补出 'decided' 态）；3 处内联 decision 字面量改 shared 导入。

## 3. 非目标

- 不改 decision 值域/wire（REVIEW_DECISION_KIND 三值不动）；不加 decided_by_kind 列。
- dispatch 侧 kind 推导与 loadUpstreamPortKind 不合并（与 shared resolveReviewInputKind
  存在同步/DB/折叠三点真实差异——挂注释互指，不强行统一）。
- approve 早返回的路径骨架保留（表化决策差异，不合并两条大路径）。
- 决策色/文案表已被 W0 收口，不重做；awaiting 'warn' 内联不并表（非决策态）。
- 多文档 selection 域（accepted/not_accepted）独立，不并入。

## 4. 验收标准

1. 策略表 satisfies 穷举 + 表值锁；submitReviewDecision/buildReviewPromptContext 内
   `args.decision ===`/`dv.decision ===` 策略分支清零（骨架分支除外，grep 棘轮）。
2. resolveReviewRoundMode 单测 + decision 侧 4 判定点收敛；行为锁测试群零改动全绿。
3. decidedBy 字面量清零（常量+谓词）；内部形态锁（full-asserts/rfc131）随迁。
4. 前端 mode variant 落地：readonly-source 源码锁改写、resolve-round-view 新单测、
   多文档 'decided' 态可表达；行为/DOM 锁群零改动全绿。
5. 门禁 + CI conclusion=success + Codex 双门收敛。
