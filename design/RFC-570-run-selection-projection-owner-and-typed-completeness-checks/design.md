# RFC-570 技术设计

落在 task-execution（domain 新增一个类型文件，public 合同、application 端口与 infrastructure 的一处改取它）、resource-catalog（application 的房间投影
声明自己的形状）、source-control（application 的两个检查函数）与 platform（删一个文件）。另改 `PUBLIC_SURFACE_DEBT`、`architecture/counts.json`、调用
两个检查的用例，新增一个 RFC-570 用例。数字取 HEAD `412767ff0`。不改行为，不改检测规则。

## 1. 运行选择投影归 owner

- 新文件 task-execution `domain/runSelection/workgroupProjection.ts`：`WorkgroupRunSelectionProjection` 原样搬来（`slot`、`current`、
  `legacyGroupCurrent`、`sequence`）。它的三个读者——`public/commands.ts`（`WorkgroupTaskRoomHostRunSnapshot.selection`）、
  `application/ports/workgroupTurnsOperations.ts`（`WorkgroupHostLedgerRun.selection`）与算出它的
  `infrastructure/runSelection/workgroupProjection.ts`——改从这里取。
- resource-catalog `application/workgroups/workgroupRoomProjection.ts`：声明自己的 `WorkgroupRoomRunSelection`（只有 `sequence` 与
  `legacyGroupCurrent`，就是这个文件读的两个字段），`WorkgroupRoomHostRun.selection` 与 `RoundLedgerRow.selection` 用它。task-execution 的完整投影在
  结构上可赋值给它，交接处不用改。
- 删除 `platform/runSelectionProjection.ts`。

## 2. 两个完整性检查

`source-control/application/workspacePorts.ts`：

```ts
export function requireIsolationWorkspaceScope(value: IsolationWorkspaceScope): void
export function requireWorkspaceUploadContent(value: WorkspaceUploadContent): void
```

函数体不变（逐个方法检查、缺了就抛同一个 `TypeError`）。三个调用点（task-execution 的 `executionWorkspaceSession.ts`、`isolationWorkspaceView.ts`、
`application/workspaceUploads.ts`）传的值本来就是这两个类型，不用改。

## 3. 门与用例

- `PUBLIC_SURFACE_DEBT` 删去 3 条，`counts.json` 的 `public-surface-deviations` 35 → 32。
- 用残缺对象调用两个检查的用例（`rfc511` 与 `rfc370-isolation-workspace-scope`）在调用处标注类型。
- 新增 `tests/rfc570-run-selection-projection-owner-boundary.test.ts`，登记 guard-manifest：① 平台文件不存在、全部源码不取它（带负对照）；
  ② 投影只在 task-execution 的 domain 声明一次，三个读者取它；resource-catalog 的房间投影不取 task-execution，自己的形状只有两个字段；③ 两个检查
  的签名；④ 行为：完整接收者通过、缺任一方法或传 null 被拒绝；⑤ 编译期断言：task-execution 的投影可赋值给 resource-catalog 的形状，两个检查收的
  就是那两个端口类型。

## 4. 取舍（可推翻）

1. **投影声明在 task-execution 的 domain，而不是留在 platform**：选择是 task-execution 算的（文件自己的注释就这样写）；放在 platform 是为了让
   resource-catalog 不必取 task-execution，而消费方用自己的窄形状声明同样做得到，还把“它只读两个字段”写进了类型。
2. **resource-catalog 的形状只声明读到的两个字段**：与 RFC-563 一致；owner 给投影加字段不牵动它。
3. **检查函数去掉 `asserts`**：入参已经是目标类型，断言签名没有读者；与旁边两个 `…Factory` 检查的写法一致。

## 5. 失败模式

- **有人把投影放回 platform，或 resource-catalog 改取 task-execution 的类型**：RFC-570 用例 ① ② 红；后者同时是越 DAG 的 import，既有的 DAG 门也红。
- **owner 改了 `sequence` / `legacyGroupCurrent` 的类型**：用例 ⑤ 的编译期断言与交接处报类型错误。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：投影在 owner 的 domain；消费方的形状在它自己的 application。**C11**：public 面的符号数不变。**C12**：RFC-570 用例覆盖全部源码（平台文件
  的读者）、投影的声明与读者、两个检查。**C13**：public 类型偏差 35 → 32，其余计数不升；platform 少一个业务投影文件；目标 DAG 不变。
- **本 RFC 承担的演进**：S9 范围第 2 项“其余 6 条”里的一条平台类型与两条开放入参。
- **留下的债**：其余 32 条（proposal 非目标一节与 RFC-569 的非目标按类别列出）。
