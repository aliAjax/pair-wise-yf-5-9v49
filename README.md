# 设备固件灰度升级服务

替代人工点选：登记设备清单后，按批次圈选设备下发固件升级；站点有在途容量
上限，超出的排队等下一批；站点断网恢复后按顺序补发未回执指令（同指令重复
送回只算一次）；固件版本出事可作废——未跑完的批次停住并回退已升设备，
已发布批次保持原样；月底与资产系统对账，列出漏升、错升、回退失败设备。

零运行时依赖，Node.js ≥ 18 即可运行（内置 `node:test`）。

## 运行

```bash
npm test     # 11 个单元/场景测试
npm run demo # 端到端演示（含中文过程输出）
```

## 领域模型

| 对象 | 关键字段 / 状态 |
| --- | --- |
| 站点 Site | `capacity` = 同时在途（已下发未回执）指令上限 |
| 设备 Device | 归属站点，`currentVersion` 随成功回执更新 |
| 固件 Firmware | `ACTIVE` / `REVOKED`（作废） |
| 升级计划 Plan | 目标版本 + 候选设备清单（设备登记在此） |
| 批次 Batch | 从计划圈选的一批设备：`PENDING → RUNNING → COMPLETED → PUBLISHED`，出事为 `HALTED` |
| 指令 Order | `QUEUED → DISPATCHED → SUCCESS/FAILED`；作废时排队指令 `CANCELED`；分 `UPGRADE`/`ROLLBACK` |

## 核心规则

1. **批次灰度**：`createBatch` 从计划清单圈设备（同一设备不能同时在两个未结束
   批次中）；`startBatch` 生成升级指令并按站点驱动下发；全部指令到终态后批次
   `COMPLETED`，人工 `publishBatch` 发布。
2. **站点容量排队**：每站点只允许 N 条在途指令（`DISPATCHED` 计数）。超出的
   留在 `QUEUED`；收到回执释放槽位后自动补位（同批次内滚动，无需等"下一批"）。
3. **断网恢复补发**：站点恢复时先把 `DISPATCHED` 未回执指令按站点单调序号
   （`siteSeq`，即下发顺序）从小到大补发，再恢复排队流量。
4. **指令幂等**：每条指令有稳定 `commandId = 站点:序号`。补发沿用同一 commandId，
   网关按 commandId 去重；重复回执（指令已到终态）返回 `accepted:false` 并计入
   `duplicateReceipts`，不会改写结果。
5. **固件作废**（幂等）：
   - 版本置 `REVOKED`，禁止新建计划/批次；
   - **已发布（PUBLISHED）批次保持原样，不回退**；
   - 其余同版本批次（PENDING/RUNNING/COMPLETED 未发布）一律 `HALTED`：排队
     指令取消，在途指令等回执，回执失败/成功都不再推进升级；
   - 已升到坏版本的设备逐台登记 `ROLLBACK` 指令，目标为**各自升级前版本**；
   - 作废后才到达的成功回执（竞态）同样落地后立即补登回退；
   - 回退指令优先于普通排队升级；回退失败进失败清单。
6. **月底对账**（输入资产系统快照 `[{deviceId, reportedVersion}]`）：
   - **漏升**：最新有效固件计划要求目标版本，设备实际不在目标版本（已作废版本
     不产生升级义务，归回退口径）；
   - **错升**：设备实际版本与资产记录不一致，含资产缺记录 / 资产有而清单无；
   - **回退失败**：回退指令收到失败回执。

## 代码结构

```
src/
  constants.js     状态枚举（固件/批次/指令/对账类别）
  errors.js        业务错误（NotFound/Conflict/FirmwareRevoked/SiteOffline）
  store.js         内存仓库与站点级指令序号（可替换为 DB 实现）
  gateway.js       设备网关：在线状态、commandId 幂等下发
  inventory.js     站点/设备/固件/计划登记
  rollout.js       批次圈选、容量排队 pumpSite、回执幂等、批次完成/发布
  recovery.js      站点断网/恢复，未回执指令按序补发
  revocation.js    固件作废：停批次、取消排队、登记并驱动回退
  reconciliation.js 月底对账：漏升/错升/回退失败
  app.js           门面 RolloutApp，组装全部服务
tests/             node:test 场景测试（容量/恢复幂等/作废/对账）
demo/demo.js       端到端中文演示
```

## 接口速览（见 `src/app.js`）

```js
const app = new RolloutApp();

app.registerSite({ siteId: 'BJ', capacity: 2 });
app.registerDevice({ deviceId: 'BJ-01', siteId: 'BJ', currentVersion: 'v1.0' });
app.registerFirmware({ version: 'v2.0' });
app.createPlan({ targetVersion: 'v2.0', deviceIds: ['BJ-01'] });

app.createBatch('plan-1', ['BJ-01'], { batchId: 'B1' });
await app.startBatch('B1');
await app.receiveReceipt('BJ:1', { ok: true }); // 设备回执入口
app.publishBatch('B1');

app.siteOffline('BJ');
await app.siteRecover('BJ');                   // 顺序补发未回执 + 恢复排队

await app.revokeFirmware('v2.0');              // 停批次 + 回退
app.listRollbackFailures();

app.monthEndReconcile(assetRecords);           // 月底对账报告
```

## 生产化备注

当前 `Store` 为单进程内存实现。接数据库时保持其方法语义即可，重点保证：
指令 `siteSeq` 站点内单调、`receiveReceipt` 以 commandId 做条件更新
（仅 `DISPATCHED → 终态`），作废与回执之间用事务或乐观锁关闭竞态。
网关 `sendCommand` 需对接真实 OTA 通道，设备侧重传回执依赖 commandId 幂等键。
