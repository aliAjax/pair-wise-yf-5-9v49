import { BatchStatus, FirmwareStatus, OrderStatus } from './constants.js';
import { NotFoundError } from './errors.js';

/**
 * 固件作废处置。
 *
 * 规则：
 *  - 固件版本出事后标记 REVOKED，禁止再用于新批次/新计划；
 *  - 已发布批次保持原样，不动；
 *  - 没跑完的批次（PENDING/RUNNING/COMPLETED 未发布）一律停住（HALTED）；
 *    尚未下发的排队指令取消，已下发未回执的不再推进，回执到达时不落地坏版本；
 *  - 已升到坏版本的设备逐台登记回退指令，刷回各自升级前版本；
 *  - 回退指令失败的设备记入失败清单，供月底对账。
 */
export class RevocationService {
  /**
   * @param {import('./store.js').Store} store
   * @param {import('./gateway.js').DeviceGateway} gateway
   * @param {import('./rollout.js').RolloutService} rollout
   */
  constructor(store, gateway, rollout) {
    this.store = store;
    this.gateway = gateway;
    this.rollout = rollout;
  }

  /**
   * 作废一个固件版本并立即处置受影响批次。幂等：重复作废不重复回退。
   * @returns {{ firmware:object, haltedBatches:string[], rollbacks:object[], rollbackFailed:object[] }}
   */
  async revoke(version) {
    const fw = this.store.firmwares.get(version);
    if (!fw) throw new NotFoundError('固件版本', version);
    fw.status = FirmwareStatus.REVOKED;
    fw.revokedAt = Date.now();

    const haltedBatches = [];
    const rollbacks = [];

    for (const batch of this.store.batches.values()) {
      if (
        batch.targetVersion === version &&
        batch.status !== BatchStatus.PUBLISHED
      ) {
        if (batch.status !== BatchStatus.HALTED) {
          batch.status = BatchStatus.HALTED;
          batch.haltedAt = Date.now();
          haltedBatches.push(batch.batchId);
        }

        // 排队中的升级指令全部取消（从未下发，不存在回退问题）
        for (const order of this.store.ordersOfBatch(batch.batchId)) {
          if (
            order.kind === 'UPGRADE' &&
            order.status === OrderStatus.QUEUED
          ) {
            order.status = OrderStatus.CANCELED;
            order.canceledAt = Date.now();
          }
        }

        // 已升到坏版本的设备逐台登记回退，目标版本为各自升级前版本
        for (const deviceId of batch.deviceIds) {
          const device = this.store.devices.get(deviceId);
          if (device.currentVersion !== version) continue;
          const up = this.store.upgradeOrder(batch.batchId, deviceId);
          if (!up || up.status !== OrderStatus.SUCCESS) continue;
          const rb = this.rollout.enqueueRollback({
            siteId: device.siteId,
            deviceId,
            revokedVersion: version,
            baseVersion: up.baseVersion,
            batchId: batch.batchId,
          });
          if (rb) rollbacks.push(rb);
        }
      }
    }

    // 回退优先：对所有受影响站点触发一次下发
    const sites = new Set(rollbacks.map((o) => o.siteId));
    for (const siteId of sites) {
      await this.rollout.pumpSite(siteId);
    }

    return {
      firmware: fw,
      haltedBatches,
      rollbacks,
      rollbackFailed: this.listRollbackFailures(),
    };
  }

  /** 回退失败清单（作废处置后回退指令收到失败回执的设备） */
  listRollbackFailures() {
    return [...this.store.orders.values()]
      .filter(
        (o) =>
          o.kind === 'ROLLBACK' && o.status === OrderStatus.FAILED,
      )
      .map((o) => ({
        deviceId: o.deviceId,
        siteId: o.siteId,
        batchId: o.batchId,
        revokedVersion: o.baseVersion,
        rollbackToVersion: o.toVersion,
        error: o.error,
        failedAt: o.receivedAt,
      }));
  }
}
