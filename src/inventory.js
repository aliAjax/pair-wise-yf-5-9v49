import { NotFoundError, ValidationError } from './errors.js';
import { FirmwareStatus } from './constants.js';

let siteCounter = 0;
let deviceCounter = 0;
let firmwareCounter = 0;
let planCounter = 0;

/**
 * 资产登记：站点、设备、固件版本、升级计划。
 */
export class InventoryService {
  /**
   * @param {import('./store.js').Store} store
   */
  constructor(store) {
    this.store = store;
  }

  /**
   * 登记站点。capacity 为该站点同时在途（已下发未回执）指令数上限。
   */
  registerSite({ siteId, name, capacity }) {
    if (siteId != null && this.store.sites.has(siteId)) {
      throw new ValidationError(`站点已存在: ${siteId}`);
    }
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new ValidationError('站点容量必须为正整数');
    }
    const id = siteId ?? `site-${++siteCounter}`;
    const site = {
      siteId: id,
      name: name ?? id,
      capacity,
      createdAt: Date.now(),
    };
    this.store.sites.set(id, site);
    return site;
  }

  /** 登记设备，必须挂在一个已登记站点下，currentVersion 为当前运行版本 */
  registerDevice({ deviceId, siteId, model, currentVersion }) {
    if (deviceId != null && this.store.devices.has(deviceId)) {
      throw new ValidationError(`设备已存在: ${deviceId}`);
    }
    if (!this.store.sites.has(siteId)) {
      throw new NotFoundError('站点', siteId);
    }
    if (!currentVersion) {
      throw new ValidationError('设备当前版本不能为空');
    }
    const id = deviceId ?? `dev-${++deviceCounter}`;
    const device = {
      deviceId: id,
      siteId,
      model: model ?? 'unknown',
      currentVersion,
      registeredAt: Date.now(),
    };
    this.store.devices.set(id, device);
    return device;
  }

  /** 登记固件版本（登记即可用，后续可作废） */
  registerFirmware({ version, packageUrl, checksum }) {
    if (this.store.firmwares.has(version)) {
      throw new ValidationError(`固件版本已存在: ${version}`);
    }
    if (!version) {
      throw new ValidationError('固件版本号不能为空');
    }
    const firmware = {
      version,
      packageUrl: packageUrl ?? `ota://fw/${version}`,
      checksum: checksum ?? null,
      status: FirmwareStatus.ACTIVE,
      registeredAt: Date.now(),
    };
    this.store.firmwares.set(version, firmware);
    return firmware;
  }

  /**
   * 创建灰度升级计划：目标固件版本 + 候选设备清单。
   * 计划只是设备清单的归属，实际按批次圈设备下发。
   */
  createPlan({ planId, name, targetVersion, deviceIds }) {
    if (planId != null && this.store.plans.has(planId)) {
      throw new ValidationError(`升级计划已存在: ${planId}`);
    }
    const fw = this.store.firmwares.get(targetVersion);
    if (!fw) {
      throw new NotFoundError('固件版本', targetVersion);
    }
    if (fw.status === FirmwareStatus.REVOKED) {
      throw new ValidationError(`目标固件版本已作废: ${targetVersion}`);
    }
    const ids = [...new Set(deviceIds ?? [])];
    for (const id of ids) {
      if (!this.store.devices.has(id)) {
        throw new NotFoundError('设备', id);
      }
    }
    const pid = planId ?? `plan-${++planCounter}`;
    const plan = {
      planId: pid,
      name: name ?? pid,
      targetVersion,
      deviceIds: ids,
      createdAt: Date.now(),
    };
    this.store.plans.set(pid, plan);
    return plan;
  }

  /** 向计划追加设备（下一批次即可圈选） */
  addDevicesToPlan(planId, deviceIds) {
    const plan = this.store.plans.get(planId);
    if (!plan) throw new NotFoundError('升级计划', planId);
    for (const id of deviceIds) {
      if (!this.store.devices.has(id)) {
        throw new NotFoundError('设备', id);
      }
      if (!plan.deviceIds.includes(id)) plan.deviceIds.push(id);
    }
    return plan;
  }
}
