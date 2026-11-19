# 调度、资源商与结算的本地接口

所有服务都在本机回环地址运行，数据及组织名称均为合成演练资料。重启来源服务会复位演练资料和当次受理记录。

## 运行

使用 Node.js 22.23.4。
运行 `npm start` 启动演练来源，默认地址为 `http://127.0.0.1:3100`，通过 `PORT` 修改端口。
运行 `npm test` 检查来源服务和原始资料。

`requests/example.json` 是业务人员提交的样例请求。
启动后处于演练阶段 0。可向 `POST /replay/phase` 发送 JSON `{"phase":1}` 切换到下一批资料。阶段切换不会清除此前受理的经办号。

## 来源接口

- `GET /dispatch/windows` 秒级时间用当天当地时刻。区间左闭右开，priority 大者优先，eligibleOutlets 为可结算的物理出口。
- `GET /partners/outlets` 相同 outlet 表示同一物理出口。parent 和 independent 指明从表是否另行计量。
- `GET /partners/access` 可领取范围按出口及起止时间。hold 表示暂缓，另有 retryAfterSeconds。
- `GET /partners/samples` quantity 为区间千瓦时，counter 为累计千瓦时。resetAt 的 before、after 为复位时读数。
- `GET /dispatch/baselines` 基线条目来自调度方，出口与区间适用范围随条目提供。
- `POST /finance/receipts` 受理时接收 requestKey、window、dispatch、netKwh。冲正另带 priorReceipt。
- `GET /finance/receipts` 凭原 requestKey 核对结算受理。
