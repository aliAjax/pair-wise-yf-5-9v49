import {
  BatchStatus,
  FirmwareStatus,
  OrderKind,
  OrderStatus,
} from './constants.js';
import {
  ConflictError,
  FirmwareRevokedError,
  NotFoundError,
  ValidationError,
} from './errors.js';

let batchCounter = 0;
let orderCounter = 0;

/** 设备尚处于未结束批次时的状态集合（已发布批次视为历史，不再占用设备） */
const ACTIVE_BATCH_STATUSES = new Set([
  BatchStatus.PENDING,
  BatchStatus.RUNNING,
  BatchStatus.COMPLETED,
  BatchStatus.HALTED,
]);

/**
 * 灰度升级核心：批次圈选、按站点容量排队下发、回执处理、发布。
 */
export class RolloutService {
  /**
   * @param {import('./store.js').Store} store
   * @param {import('./gateway.js').DeviceGateway} gateway
   */
  constructor(store, gateway) {
    this.store = store;
    this.gateway = gateway;
  }

  /**
   * 按批次圈选设备：从计划清单中挑选一批设备登记为一个批次。
   * 此时不产生任何指令，startBatch 后才下发。
   */
  createBatch(planId, deviceIds, opts = {}) {
    const plan = this.store.plans.get(planId);
    if (!plan) throw new NotFoundError('升级计划', planId);
    const fw = this.store.firmwares.get(plan.targetVersion);
    if (fw.status === FirmwareStatus.REVOKED) {
      throw new FirmwareRevokedError(plan.targetVersion);
    }

    const ids = [...new Set(deviceIds ?? [])];
    if (ids.length === 0) {
      throw new ValidationError('批次至少要圈选一台设备');
    }
    for (const id of ids) {
      if (!plan.deviceIds.includes(id)) {
        throw new ValidationError(`设备 ${id} 不在计划 ${planId} 清单中`);
      }
      const occupied = this._activeBatchOfDevice(id);
      if (occupied) {
        throw new ConflictError(
          `设备 ${id} 已在未结束批次 ${occupied} 中，不能重复圈选`,
        );
      }
    }

    const batchId = opts.batchId ?? `batch-${++batchCounter}`;
    if (this.store.batches.has(batchId)) {
      throw new ValidationError(`批次已存在: ${batchId}`);
    }
    const batch = {
      batchId,
      planId,
      targetVersion: plan.targetVersion,
      deviceIds: ids,
      status: BatchStatus.PENDING,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      publishedAt: null,
    };
    this.store.batches.set(batchId, batch);
    return batch;
  }

  /**
   * 启动批次：为每台设备生成升级指令并入站点队列，
   * 随后按各站点容量尽力下发，超出容量的排队等槽位。
   */
  async startBatch(batchId) {
    const batch = this.store.batches.get(batchId);
    if (!batch) throw new NotFoundError('批次', batchId);

    if (batch.status === BatchStatus.RUNNING) {
      // 幂等重入：只补一次下发尝试
    } else if (batch.status === BatchStatus.PENDING) {
      const fw = this.store.firmwares.get(batch.targetVersion);
      if (fw.status === FirmwareStatus.REVOKED) {
        throw new FirmwareRevokedError(batch.targetVersion);
      }
      batch.status = BatchStatus.RUNNING;
      batch.startedAt = Date.now();
      for (const deviceId of batch.deviceIds) {
        const device = this.store.devices.get(deviceId);
        const seq = this.store.nextOrderSeq(device.siteId);
        this._storeOrder(
          this._newOrder({
            batch,
            device,
            siteId: device.siteId,
            kind: OrderKind.UPGRADE,
            toVersion: batch.targetVersion,
            baseVersion: device.currentVersion,
            seq,
          }),
        );
      }
    } else {
      throw new ConflictError(
        `批次 ${batchId} 状态为 ${batch.status}，不能启动`,
      );
    }

    for (const siteId of this._sitesOfBatch(batchId)) {
      await this.pumpSite(siteId);
    }
    return batch;
  }

  /**
   * 发布批次：批次跑完（所有升级指令到终态）后人工发布。
   * 已发布批次在固件作废时保持原样，不回退。
   */
  publishBatch(batchId) {
    const batch = this.store.batches.get(batchId);
    if (!batch) throw new NotFoundError('批次', batchId);
    if (batch.status !== BatchStatus.COMPLETED) {
      throw new ConflictError(
        `批次 ${batchId} 状态为 ${batch.status}，只有跑完的批次可发布`,
      );
    }
    batch.status = BatchStatus.PUBLISHED;
    batch.publishedAt = Date.now();
    return batch;
  }

  /**
   * 站点驱动：在容量允许范围内把排队指令下发出去。
   * 选择规则：
   *  1. 回退指令优先（作废处置优先于新升级流量）；
   *  2. 同类按站点序号（下发顺序）先来先得；
   *  3. 升级指令只属于 RUNNING 批次；批次已停住/结束的不发。
   * 断网站点：排队指令保留 QUEUED，等恢复后补发。
   */
  async pumpSite(siteId) {
    const site = this.store.getSite(siteId);
    if (!site) throw new NotFoundError('站点', siteId);
    if (!this.gateway.isOnline(siteId)) return;

    for (;;) {
      const inFlight = this.store.countSiteOrders(
        siteId,
        (o) => o.status === OrderStatus.DISPATCHED,
      );
      if (inFlight >= site.capacity) return;

      const next = this._nextQueuedOrder(siteId);
      if (!next) return;

      next.status = OrderStatus.DISPATCHED;
      next.dispatchedAt = Date.now();
      next.attempts += 1;
      try {
        await this.gateway.sendCommand(next);
      } catch (err) {
        if (err.name === 'SiteOfflineError') {
          // 下发瞬间断网：退回队列，恢复时按顺序补发
          next.status = OrderStatus.QUEUED;
          next.dispatchedAt = null;
          return;
        }
        next.status = OrderStatus.FAILED;
        next.error = err.message;
        continue;
      }
    }
  }

  /**
   * 接收设备回执。commandId 幂等：同一指令重复送回只算一次，
   * 非 DISPATCHED 状态收到的回执记为重复回执并忽略。
   */
  async receiveReceipt(commandId, result = {}) {
    const order = this._findByCommandId(commandId);
    if (!order) throw new NotFoundError('指令', commandId);

    if (order.status !== OrderStatus.DISPATCHED) {
      order.duplicateReceipts = (order.duplicateReceipts ?? 0) + 1;
      return { accepted: false, duplicate: true, order };
    }

    order.receivedAt = Date.now();
    const device = this.store.devices.get(order.deviceId);

    if (result.ok) {
      order.status = OrderStatus.SUCCESS;
      device.currentVersion = order.toVersion;
      if (order.kind === OrderKind.UPGRADE) {
        // 关闭竞态：回执到达时固件刚好已作废且批次未发布，立即登记回退
        const fw = this.store.firmwares.get(order.toVersion);
        const batch = this.store.batches.get(order.batchId);
        if (
          fw?.status === FirmwareStatus.REVOKED &&
          batch &&
          batch.status !== BatchStatus.PUBLISHED &&
          !this._hasRollback(order.deviceId, order.batchId)
        ) {
          this.enqueueRollback({
            siteId: order.siteId,
            deviceId: order.deviceId,
            revokedVersion: order.toVersion,
            baseVersion: order.baseVersion,
            batchId: order.batchId,
          });
        }
      }
    } else {
      order.status = OrderStatus.FAILED;
      order.error = result.error ?? '设备上报失败';
    }

    this._completeBatchIfDone(order.batchId);
    await this.pumpSite(order.siteId);
    return { accepted: true, duplicate: false, order };
  }

  /**
   * 作废处置时登记回退指令（供 revocation 模块和回执竞态使用）。
   * 同一批次同一设备只登记一条回退指令。
   */
  enqueueRollback({ siteId, deviceId, revokedVersion, baseVersion, batchId }) {
    if (this._hasRollback(deviceId, batchId)) return null;
    const seq = this.store.nextOrderSeq(siteId);
    const order = this._newOrder({
      batch: { batchId, targetVersion: revokedVersion },
      device: this.store.devices.get(deviceId),
      siteId,
      kind: OrderKind.ROLLBACK,
      toVersion: baseVersion,
      baseVersion: revokedVersion,
      seq,
    });
    this._storeOrder(order);
    return order;
  }

  // ---------- 内部方法 ----------

  _storeOrder(order) {
    order.orderId = `order-${++orderCounter}`;
    this.store.orders.set(order.orderId, order);
    return order;
  }

  _newOrder({ batch, device, siteId, kind, toVersion, baseVersion, seq }) {
    return {
      orderId: null,
      commandId: `${siteId}:${seq}`,
      batchId: batch.batchId,
      planId: this.store.batches.get(batch.batchId)?.planId ?? null,
      deviceId: device.deviceId,
      siteId,
      siteSeq: seq,
      kind,
      status: OrderStatus.QUEUED,
      toVersion,
      /** 升级前版本，回退目标版本；回退指令里记录被回退的坏版本 */
      baseVersion,
      attempts: 0,
      duplicateReceipts: 0,
      error: null,
      createdAt: Date.now(),
      dispatchedAt: null,
      receivedAt: null,
    };
  }

  _nextQueuedOrder(siteId) {
    const queued = this.store
      .ordersOfSite(siteId)
      .filter((o) => o.status === OrderStatus.QUEUED)
      .filter((o) => {
        if (o.kind === OrderKind.ROLLBACK) return true;
        const batch = this.store.batches.get(o.batchId);
        return batch?.status === BatchStatus.RUNNING;
      });
    queued.sort((a, b) => {
      // 回退优先，其次按站点下发序号
      if (a.kind !== b.kind) {
        return a.kind === OrderKind.ROLLBACK ? -1 : 1;
      }
      return a.siteSeq - b.siteSeq;
    });
    return queued[0] ?? null;
  }

  _completeBatchIfDone(batchId) {
    const batch = this.store.batches.get(batchId);
    if (!batch || batch.status !== BatchStatus.RUNNING) return;
    const pending = this.store
      .ordersOfBatch(batchId)
      .filter((o) => o.kind === OrderKind.UPGRADE)
      .some(
        (o) =>
          o.status === OrderStatus.QUEUED ||
          o.status === OrderStatus.DISPATCHED,
      );
    if (!pending) {
      batch.status = BatchStatus.COMPLETED;
      batch.completedAt = Date.now();
    }
  }

  _activeBatchOfDevice(deviceId) {
    for (const batch of this.store.batches.values()) {
      if (
        ACTIVE_BATCH_STATUSES.has(batch.status) &&
        batch.deviceIds.includes(deviceId)
      ) {
        return batch.batchId;
      }
    }
    return null;
  }

  _hasRollback(deviceId, batchId) {
    return this.store.ordersOfBatch(batchId).some(
      (o) => o.kind === OrderKind.ROLLBACK && o.deviceId === deviceId,
    );
  }

  _findByCommandId(commandId) {
    for (const order of this.store.orders.values()) {
      if (order.commandId === commandId) return order;
    }
    return null;
  }

  _sitesOfBatch(batchId) {
    const sites = new Set();
    for (const deviceId of this.store.getBatch(batchId).deviceIds) {
      sites.add(this.store.devices.get(deviceId).siteId);
    }
    return [...sites];
  }
}
