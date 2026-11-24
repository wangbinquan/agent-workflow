# RFC-558 技术设计

落在 integration（webhook 入站的装配与新的窄端口）一个 bounded context；bootstrap 与 event-center 不改代码。另改两份精确清单、
`architecture/counts.json` 与新增一个 RFC-558 用例。数字取 HEAD `014a79f85`。不改行为。

## 1. 改动

| 位置                                                               | 做法                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| integration `application/ports/webhookIngressEventCenter.ts`（新） | `WebhookIngressEventCenter`：`commands: EventObservationParticipant`、`worker.runOneNotification(deliveryId?)`、`observerControl.nudgeSource(sourceRef: EventExactRef)`（返回类型与事件中心模块相同） |
| integration `composition/webhookIngress.ts`                        | `composeWebhookDeliveryRuntimeFor` 与 `composeWebhookDeliveryReplay` 的 `digitalEmployeeEventCenter` 改用它；删去对 event-center composition 的 import                                                |

bootstrap 交的仍是 event-center 装配出的事件中心模块：它的 `commands` 就是 `EventObservationParticipant`，`worker` 与 `observerControl` 的签名与端口
相同，编译器在交接处检查。

## 2. 门与用例

- 精确清单：`rfc376-structural-guards` 与 `rfc294-architecture-preflight` 的跨 context 内部文件对删去这一条；`counts.json` 7 → 6。
- 新增 `tests/rfc558-webhook-ingress-event-center-port-boundary.test.ts`，登记 guard-manifest：① integration 全部源码取 event-center 非 public 文件的
  只剩指定 adapter 按类型取 required-ports（带负对照）；② 端口只取 event-center 的 public；`webhookIngress.ts` 用它；③ 编译期断言：事件中心模块
  可以赋给 `WebhookIngressEventCenter`。

## 3. 失败模式

- **事件中心模块的这三个操作改了签名**：端口与 bootstrap 交接处、以及新用例的编译期断言都会报类型错误。

## 4. 取舍（可推翻）

1. **consumer 自有窄端口，而不是把 worker / observerControl 搬进 event-center 的 public**：这两个是事件中心的运维面，没有别的跨 context 消费方；
   入站只需要这三个调用，由 consumer 声明需要什么（RFC-553 同一做法）。

## 5. 对 RFC-294 刷新后规则的对账

- **C10**：端口归 consumer integration 的 `application/ports`，只取 event-center 的 exact public。**C11**：两个 context 的 public 都不变。**C12**：RFC-558
  用例覆盖。**C13**：跨 context 内部文件对 7 → 6，其余计数不升。
