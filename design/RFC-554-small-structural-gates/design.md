# RFC-554 技术设计

落在 runtime-management（application 的注册表文件）与 integration（仓库端点发现的位置）两个 bounded context；另改 `rfc376-structural-guards`
的两份精确清单、`architecture/counts.json` 与新增一个 RFC-554 用例。数字取 HEAD `f21441af5`。不改行为。

## 1. 改动

| 位置                                                     | 现状                                            | 做法                                                                         |
| -------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| runtime-management `application/runtimeRegistry.ts`      | 末尾 `export * from '../domain/runtimeProfile'` | 删除（没有任何文件经它取 domain 的名字）                                     |
| integration `application/repositoryEndpointDiscovery.ts` | HTTP 适配器、全局 `fetch` 回落                  | 原样挪到 `infrastructure/codeHost/repositoryEndpointDiscovery.ts`            |
| integration `composition.ts`                             | 从 application 转出它                           | 改从 infrastructure 转出（组合根照旧把它交给 source-control 的端点发现端口） |
| 两个 RFC-321 用例                                        | 从 application 取它                             | 改取新位置                                                                   |

“没有文件经它取名字”的判据：对 backend 的 src 与用例，逐条看指向 `runtimeRegistry` 的 import / 转出 / 命名空间 import，取到的名字与
`domain/runtimeProfile` 的导出取交集，结果为空（实测）。删除后 `tsc` 复核。

## 2. 门与用例

- `rfc376-structural-guards` 的 `export-star-barrels` 清单清空、`application-direct-effect-files` 删去仓库端点发现那一条；`counts.json` 两项
  1 → 0、2 → 1。
- 新增 `tests/rfc554-small-structural-gates-boundary.test.ts`，登记 guard-manifest：① `runtimeRegistry.ts` 没有 `export *`；② 仓库端点发现在
  infrastructure、application 下没有它，组合根从新位置转出；③ 全仓（backend src）没有文件经 `application/runtimeRegistry` 取 domain 的名字
  （带负对照）。

## 3. 失败模式

- **有人经门面取 domain 名字**：实测没有；`tsc` 复核。

## 4. 取舍（可推翻）

1. **挪文件而不是只把 `fetch` 回落改成必填**：文件整体是 HTTP 适配器（路径、鉴权头、响应解析），按内容属于 infrastructure。

## 5. 对 RFC-294 刷新后规则的对账

- **C10**：适配器归 infrastructure。**C11**：public 不变。**C12**：RFC-554 用例覆盖。**C13**：`export-star-barrels` 1 → 0、
  `application-direct-effect-files` 2 → 1，其余计数不升。
