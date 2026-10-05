/**
 * 内存数据仓库（单进程实现）。
 * 生产环境可替换为数据库实现，接口保持一致即可。
 *
 * 指令序号 orderSeq 是站点级单调递增，用于：
 *  1. 站点恢复后按顺序补发未回执指令；
 *  2. 网关侧命令幂等（同 commandId 重投只生效一次）。
 */
export class Store {
  constructor() {
    /** @type {Map<string, object>} 站点 siteId -> site */
    this.sites = new Map();
    /** @type {Map<string, object>} 设备 deviceId -> device */
    this.devices = new Map();
    /** @type {Map<string, object>} 固件版本号 -> firmware */
    this.firmwares = new Map();
    /** @type {Map<string, object>} 升级计划 planId -> plan */
    this.plans = new Map();
    /** @type {Map<string, object>} 批次 batchId -> batch */
    this.batches = new Map();
    /** @type {Map<string, object>} 指令 orderId -> order */
    this.orders = new Map();

    /** 站点 -> 下一个指令序号 */
    this._siteSeq = new Map();
  }

  nextOrderSeq(siteId) {
    const n = (this._siteSeq.get(siteId) ?? 0) + 1;
    this._siteSeq.set(siteId, n);
    return n;
  }

  getSite(siteId) {
    return this.sites.get(siteId);
  }

  getDevice(deviceId) {
    return this.devices.get(deviceId);
  }

  getFirmware(version) {
    return this.firmwares.get(version);
  }

  getBatch(batchId) {
    return this.batches.get(batchId);
  }

  getPlan(planId) {
    return this.plans.get(planId);
  }

  getOrder(orderId) {
    return this.orders.get(orderId);
  }

  /** 站点下所有指令，按序号升序（即下发顺序） */
  ordersOfSite(siteId) {
    return [...this.orders.values()]
      .filter((o) => o.siteId === siteId)
      .sort((a, b) => a.siteSeq - b.siteSeq);
  }

  /** 批次下所有指令（创建顺序与站点序号顺序一致，这里显式按序号排） */
  ordersOfBatch(batchId) {
    return [...this.orders.values()]
      .filter((o) => o.batchId === batchId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 某批次某设备的升级指令（用于作废时判断该设备是否已升级成功） */
  upgradeOrder(batchId, deviceId) {
    return this.ordersOfBatch(batchId).find(
      (o) => o.deviceId === deviceId && o.kind === 'UPGRADE',
    );
  }

  /** 站点下处于某状态的指令数量（容量控制的依据） */
  countSiteOrders(siteId, pred) {
    let n = 0;
    for (const o of this.orders.values()) {
      if (o.siteId === siteId && pred(o)) n += 1;
    }
    return n;
  }
}
