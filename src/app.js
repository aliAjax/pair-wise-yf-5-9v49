import { DeviceGateway } from './gateway.js';
import { InventoryService } from './inventory.js';
import { ReconciliationService } from './reconciliation.js';
import { RecoveryService } from './recovery.js';
import { RevocationService } from './revocation.js';
import { RolloutService } from './rollout.js';
import { Store } from './store.js';

/**
 * 灰度升级服务门面：组装各领域服务，对外暴露统一入口。
 * 替换存储时只需在构造时注入新的 Store 实现。
 */
export class RolloutApp {
  constructor({ store, gateway } = {}) {
    this.store = store ?? new Store();
    this.gateway = gateway ?? new DeviceGateway();

    this.inventory = new InventoryService(this.store);
    this.rollout = new RolloutService(this.store, this.gateway);
    this.recovery = new RecoveryService(
      this.store,
      this.gateway,
      this.rollout,
    );
    this.revocation = new RevocationService(
      this.store,
      this.gateway,
      this.rollout,
    );
    this.reconciliation = new ReconciliationService(this.store);
  }

  // ---- 登记 ----
  registerSite(input) {
    return this.inventory.registerSite(input);
  }

  registerDevice(input) {
    return this.inventory.registerDevice(input);
  }

  registerFirmware(input) {
    return this.inventory.registerFirmware(input);
  }

  createPlan(input) {
    return this.inventory.createPlan(input);
  }

  // ---- 批次灰度 ----
  createBatch(planId, deviceIds, opts) {
    return this.rollout.createBatch(planId, deviceIds, opts);
  }

  startBatch(batchId) {
    return this.rollout.startBatch(batchId);
  }

  publishBatch(batchId) {
    return this.rollout.publishBatch(batchId);
  }

  receiveReceipt(commandId, result) {
    return this.rollout.receiveReceipt(commandId, result);
  }

  // ---- 断网恢复 ----
  siteOffline(siteId) {
    return this.recovery.siteOffline(siteId);
  }

  siteRecover(siteId) {
    return this.recovery.siteRecover(siteId);
  }

  // ---- 固件作废 ----
  revokeFirmware(version) {
    return this.revocation.revoke(version);
  }

  listRollbackFailures() {
    return this.revocation.listRollbackFailures();
  }

  // ---- 月底对账 ----
  monthEndReconcile(assetRecords, opts) {
    return this.reconciliation.reconcile(assetRecords, opts);
  }

  // ---- 查询辅助 ----
  getBatch(batchId) {
    return this.store.getBatch(batchId);
  }

  getDevice(deviceId) {
    return this.store.getDevice(deviceId);
  }

  ordersOfBatch(batchId) {
    return this.store.ordersOfBatch(batchId);
  }
}
