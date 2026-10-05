import { SiteOfflineError } from './errors.js';

/**
 * 设备网关：模拟向真实站点/设备通道下发指令。
 *
 * 关键语义：
 *  - 站点断网时 sendCommand 抛 SiteOfflineError，指令保留在 DISPATCHED/QUEUED 状态；
 *  - commandId 幂等：同一指令补发使用相同 commandId，
 *    设备端重复送达只生效一次（重复送达计数可观测，但回执以第一条为准）。
 */
export class DeviceGateway {
  constructor() {
    /** 站点在线状态 siteId -> boolean（默认在线） */
    this.online = new Map();
    /** commandId -> 已送达次数 */
    this.deliveryCount = new Map();
    /** 最后一次下发内容，供测试/演示断言 */
    this.lastSent = null;
  }

  isOnline(siteId) {
    return this.online.get(siteId) ?? true;
  }

  setSiteOnline(siteId, online) {
    this.online.set(siteId, online);
  }

  /**
   * 向设备通道发送指令。
   * @param {object} order 指令（含 commandId/siteId/deviceId/payload）
   */
  async sendCommand(order) {
    if (!this.isOnline(order.siteId)) {
      throw new SiteOfflineError(order.siteId);
    }
    const times = (this.deliveryCount.get(order.commandId) ?? 0) + 1;
    this.deliveryCount.set(order.commandId, times);
    this.lastSent = order;
    return { delivered: true, duplicate: times > 1, times };
  }

  deliveryTimes(commandId) {
    return this.deliveryCount.get(commandId) ?? 0;
  }
}
