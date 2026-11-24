# RFC-569 技术设计

落在 task-execution（public 合同、domain、infrastructure）、resource-catalog（public 合同、domain）、development-automation（application 合同）、
integration（策略的实现）与 `routes/tasks.ts`（一个调用点）。另改 `PUBLIC_SURFACE_DEBT`、`architecture/counts.json`、构造这些形状的用例，新增一个
RFC-569 用例。数字取 HEAD `0a1069435`。不改行为，不改检测规则。

## 1. 修复后的告警通知：复用 `TaskLifecycleAlertNotices`

`TaskRouteOperations.applyRepair` 的入参删去 `onAlert`、`onResolved`，改收 `notices: TaskLifecycleAlertNotices`（`application/ports/taskDiagnostics.ts`
里既有的闭合接口：`alert(notice, transition)`、`resolved(taskId)`，诊断用例 `diagnose(taskId, notices)` 用的是同一个）。

- `infrastructure/taskRouteRepairOperations.ts`：对外的 `applyRepair` 把 `notices` 接到内部修复执行的两个回调上（告警行照旧只取
  `taskId`、`rule`、`severity` 三个字段交出去）；只为可空回调存在的 `noticeCallback` 删去。内部的修复执行与自动修复的入参不在 public 合同上，不动。
- `routes/tasks.ts`：修复路由传已有的 `LIFECYCLE_ALERT_NOTICES`（诊断路由传的同一个对象）。

## 2. 终态工作区回收策略：一个方法的闭合接口

`domain/terminalWorkspacePrune.ts`：

```ts
export interface TerminalWorkspacePruneCandidate {
  readonly taskId: string
  readonly spaceKind: Task['spaceKind']
  readonly workspacePruningAt: number | null
  readonly workspacePruneCause: WorkspacePruneCause | null
  readonly workspacePrunedAt: number | null
}
export interface TerminalWorkspacePrunePolicy {
  decide(
    row: TerminalWorkspacePruneCandidate,
    to: TaskStatus,
  ): Promise<TerminalWorkspacePruneDecision>
}
```

- 两个实现：task-execution 的 `neverPruneTerminalWorkspaces` 与 integration 的 `createWebhookTerminalWorkspacePrunePolicy` 改为返回带 `decide` 的对象。
- 唯一的调用点 `resolveTerminalWorkspacePruneDecision` 改调 `policy.decide(row, to)`；“只在 `done` / `canceled` 时询问、策略抛错时记日志并不回收”不变。
- 其余把策略当值传递的位置不用改。

## 3. 技能版本提交的钩子：两个可选方法

`SkillVersionCommitHooks<R>` 的 `before`、`after` 由函数类型的只读属性改为可选方法（`before?(): R`、`after?(versionIndex: number): R`）。调用点
`hooks?.before?.()`、`hooks?.after?.(versionIndex)` 与融合交入的对象字面量都不用改。

## 4. 需求文件视图：继承下载句柄

`DevelopmentMissionFileView` 改为 `extends EvidenceDownloadHandle`，自己只留 `mediaType`、`bytes`；`openAll()`、`open(start, endInclusive)` 的声明
只剩 `EvidenceDownloadHandle` 那一处。视图对象的键（`bytes`、`mediaType`、`open`、`openAll`）与出站校验不变。

## 5. “插件已停用”问题码：常量与类型各写一处

`domain/disabledResourcePolicy.ts` 声明 `type PluginDisabledErrorCode = 'plugin-disabled'`，常量 `PLUGIN_DISABLED_ERROR_CODE` 标注成这个类型；
`public/types.ts` 的 `AgentResourceIssueCode` 取这个类型，不再 `typeof` 常量。

## 6. 门与用例

- `PUBLIC_SURFACE_DEBT` 删去 5 条，`counts.json` 的 `public-surface-deviations` 40 → 35。
- 构造策略、调用 `applyRepair` 的用例随改。
- 新增 `tests/rfc569-public-callback-members-closed-boundary.test.ts`，登记 guard-manifest：① 五个声明里没有函数类型节点与类型查询（带负对照）；
  ② `applyRepair` 收 `notices`，修复路由与诊断路由传同一个对象；③ 策略只有一个调用点、它调的是 `decide`；④ 行为：策略只在两个终态被询问、抛错时
  不回收，“永不回收”策略的结果，`applyRepair` 把告警行的三个字段与解决的任务交给 `notices`；⑤ 编译期断言：两个策略实现与文件视图的形状。

## 7. 取舍（可推翻）

1. **只收“收完更简单”的五条**：告警通知复用既有接口、文件视图去掉重复声明、问题码去掉 `typeof`，策略与钩子变成具名的方法。借贷式高阶入参
   （`withPreviewIndex(operation)` 一类）若也改成“只有一个方法的对象”，调用点全部要多包一层，得不偿失；它们是否算合同的正当形态，留给检测规则的
   讨论（须用户确认）。
2. **策略的方法名用 `decide`**：与返回类型 `TerminalWorkspacePruneDecision`、调用点 `resolveTerminalWorkspacePruneDecision` 同词。
3. **修复路径的 `notices` 必填**：原来两个回调在 public 合同上就是必填的；内部自动修复那一路的可空回调不在合同上，保持原样。

## 8. 失败模式

- **有人把回调属性或 `typeof` 写回这五处**：RFC-569 用例 ① 与 `PUBLIC_SURFACE_DEBT` 的精确比对同红。
- **新的策略实现忘了处理抛错**：调用点统一兜住（记日志、不回收），用例 ④ 覆盖。

## 9. 对 RFC-294 刷新后规则的对账

- **C10**：策略类型在 task-execution 的 domain，通知接口在它的 application 端口，实现各在 infrastructure / integration 的 application。**C11**：
  public 面的符号数不变（收的是形状）。**C12**：RFC-569 用例覆盖五个声明、两个路由调用点与策略的调用点。**C13**：public 类型偏差 40 → 35，其余
  计数不升；目标 DAG 不变。
- **本 RFC 承担的演进**：S9 范围第 2 项“开放类型收成闭合接口”里不需要讨论检测规则的五条。
- **留下的债**：其余 35 条（非目标一节按类别列出）。
