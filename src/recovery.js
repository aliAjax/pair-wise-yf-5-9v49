import { NotFoundError } from './errors.js';

/**
 * 站点连通性与断网恢复。
 *
 * 恢复语义：站点重新上线后，先把“下发了但没有回执”的指令
 * （DISPATCHED）按站点序号顺序补发，再恢复排队流量。
 * 补发沿用原 commandId，设备端/网关按 commandId 幂等，
 * 同一指令重复送回只算一次。
 */
export class RecoveryService {
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

  siteOffline(siteId) {
    const site = this.store.getSite(siteId);
    if (!site) throw new NotFoundError('站点', siteId);
    this.gateway.setSiteOnline(siteId, false);
    site.lastOfflineAt = Date.now();
    return site;
  }

  /**
   * 站点恢复上线：按顺序补发未回执指令，再驱动排队下发。
   * @returns {{ siteId:string, resent:object[] }}
   */
  async siteRecover(siteId) {
    const site = this.store.getSite(siteId);
    if (!site) throw new NotFoundError('站点', siteId);
    this.gateway.setSiteOnline(siteId, true);
    site.lastRecoveredAt = Date.now();

    const resent = [];

    // 1) 顺序补发已下发未回执的指令（含升级与回退，同序即同优先级）
    const pending = this.store
      .ordersOfSite(siteId)
      .filter((o) => o.status === 'DISPATCHED')
      .sort((a, b) => a.siteSeq - b.siteSeq);

    for (const order of pending) {
      order.attempts += 1;
      order.lastResentAt = Date.now();
      // 网关按 commandId 幂等：重复投递不产生第二条生效指令
      await this.gateway.sendCommand(order);
      resent.push(order);
    }

    // 2) 排队指令（容量内）继续下发
    await this.rollout.pumpSite(siteId);

    return { siteId, resent };
  }
}
