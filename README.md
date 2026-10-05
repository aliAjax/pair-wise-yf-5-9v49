# 灰度升级服务

设备固件升级以前靠人工点选，站点一多就管不住。本服务把设备按**批次**圈定后下发升级指令，内置站点容量管控、断网恢复补发、指令回执幂等、固件作废回退与月度资产对账能力。

## 核心概念

| 概念 | 说明 |
| --- | --- |
| 站点 Station | 设备所属机房/站点，有 `capacity`（并发升级上限）与 `online`（在线/断网）状态 |
| 设备 Device | 登记的设备清单，含资产编号、型号、当前固件版本、资产系统应有版本 |
| 固件 Firmware | 固件版本，状态流转：`draft → published → invalid`（作废） |
| 升级活动 Campaign | 针对某一固件的一次升级，下分多个批次 |
| 批次 Batch | 一次圈选的设备集合，状态：`pending → running → completed → published`；作废时未发布批次置 `paused` |
| 升级任务 Task | 某台设备在某批次中的升级/回退任务，状态：`queued → dispatched → upgraded/failed → rolling_back → rolled_back/rollback_failed` |
| 指令 Command | 下发给站点的升级/回退指令，带站点内单调 `sequence_no` 与唯一 `idempotency_key` |

## 关键设计

### 1. 站点容量管控，超出排队
每个站点有并发上限 `capacity`。派发批次时，按站点分组、按 `sequence_no` 顺序下发，**在途（dispatched 未回执）任务数达到容量即止**，其余任务保持 `queued`，排队等下一批。新建下一批次时，上一批排队任务自动结转到新批次。

### 2. 断网恢复，按顺序补发
- 站点断网期间，指令不实际下发（保持 `pending`）。
- 站点恢复（`POST /api/stations/:id/recover`）时：
  1. **先补发**已下发但未回执（`dispatched`）的指令，按 `sequence_no` 顺序重试（`retry_count` 累加）；
  2. **再下发**排队中的新指令，升级指令受容量限制，回退指令优先下发。

### 3. 回执幂等
每条指令有唯一 `idempotency_key`。同一指令重复回执（站点重发）只生效一次：首次回执推进任务状态，重复回执直接返回 `idempotent: true`，不重复升级/回退。

### 4. 固件作废
`POST /api/firmwares/:id/invalidate` 将固件置为 `invalid`，并处理所有关联活动：
- **已发布批次（published）保持原样**，不回退；
- **未发布批次立即停住**（`paused`），不再下发新指令；
- 已升级设备生成回退指令（回退到 `from_version`）；在途未回执任务中止（不升级）；
- 回退失败的任务标记 `rollback_failed`。

### 5. 月度对账
`POST /api/reconcile` 对比设备当前版本与资产系统同步的应有版本（`expected_version`），列出三类设备：
- **漏升**：当前版本落后于资产系统要求版本（该升没升）；
- **错升**：设备仍在作废固件版本上（含已发布批次中按策略保留、未强制回退的设备），或版本高于资产要求；
- **回退失败**：作废后回退指令回执失败，仍停留在作废版本。

> 说明：已发布批次按"保持原样"策略不强制回退，但其中停留在作废版本的设备仍会在对账中列出，供人工跟进。

## 快速开始

```bash
npm install

# 端到端演示（登记→批次→容量排队→回执幂等→断网补发→作废回退→对账）
npm run demo

# 启动 HTTP 服务（默认端口 3000，数据落 data/upgrade.db）
npm start
# 或自定义端口/数据库路径
PORT=3100 DB_PATH=/tmp/upgrade.db npm start

# 单元测试
npm test
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/stations` | 新建站点（name/capacity） |
| GET | `/api/stations` | 站点列表（含在途/排队数） |
| PATCH | `/api/stations/:id` | 更新站点容量/在线状态 |
| POST | `/api/stations/:id/recover` | 断网恢复：补发未回执指令 + 下发排队指令 |
| POST | `/api/devices` | 批量登记设备（devices 数组，按 asset_tag upsert） |
| GET | `/api/devices` | 设备列表（可按 station_id/model/status 过滤） |
| POST | `/api/asset/sync` | 资产系统同步应有版本（updates: [{asset_tag, expected_version}]） |
| POST | `/api/firmwares` | 新建固件（draft） |
| GET | `/api/firmwares` | 固件列表 |
| POST | `/api/firmwares/:id/publish` | 发布固件 |
| POST | `/api/firmwares/:id/invalidate` | 固件作废：停住未发布批次、回退已升设备 |
| POST | `/api/campaigns` | 新建升级活动 + 批次1（firmware_id, device_ids） |
| GET | `/api/campaigns` | 活动列表 |
| GET | `/api/campaigns/:id` | 活动详情（含批次） |
| POST | `/api/campaigns/:id/batches` | 新建下一批次（自动结转排队任务，可加新设备） |
| POST | `/api/batches/:id/dispatch` | 派发批次（受站点容量限制） |
| POST | `/api/batches/:id/publish` | 发布批次（已发布批次作废时豁免） |
| GET | `/api/batches/:id` | 批次详情（含任务） |
| POST | `/api/commands/:id/ack` | 指令回执（success/failure，幂等） |
| GET | `/api/commands` | 指令列表（可按 station_id/status/type 过滤） |
| POST | `/api/reconcile` | 执行月度对账 |
| GET | `/api/reconcile` | 对账历史 |

## 业务流程示例

```
登记站点/设备 → 发布固件 → 建活动+批次1（圈设备）
     → 派发（容量内下发，超出排队）→ 回执（成功/失败，重复回执幂等）
     → 建下一批（排队任务结转）→ 派发 → 回执
     → 站点断网（指令 pending）→ 恢复（补发未回执 + 下发排队）
     → 固件作废（未发布批次停住、已升级回退，已发布批次保留）
     → 回退回执（成功 / 失败）
     → 资产同步应有版本 → 月度对账（漏升/错升/回退失败）
```

## 技术栈

- Node.js + Express
- SQLite（[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)，嵌入式零运维，WAL 模式）
- 事务保证批次结转、作废回退、回执状态一致
