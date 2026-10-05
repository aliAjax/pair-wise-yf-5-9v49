import { FirmwareStatus, IssueCategory, OrderKind, OrderStatus } from './constants.js';

/**
 * 月底对账服务。
 *
 * 数据来源：
 *  - 升级系统内部：计划、批次、指令、设备当前版本；
 *  - 资产系统快照：由调用方提供 assetRecords（设备上报/资产盘点的版本），
 *    形如 [{ deviceId, reportedVersion }]。
 *
 * 输出三类问题：
 *  - 漏升 MISSED：有效（未作废）计划要求升到目标版本，
 *    设备实际版本不在目标版本，且未登记回退；
 *  - 错升 WRONG_VERSION：设备实际版本与资产系统记录不一致
 *    （含资产系统缺失该设备记录、资产系统有但设备清单未登记）；
 *  - 回退失败 ROLLBACK_FAILED：作废后回退指令收到失败回执。
 */
export class ReconciliationService {
  /**
   * @param {import('./store.js').Store} store
   */
  constructor(store) {
    this.store = store;
  }

  /**
   * @param {Array<{deviceId:string, reportedVersion:string}>} assetRecords
   * @param {{asOf?:number}} [opts]
   */
  reconcile(assetRecords = [], opts = {}) {
    const assetByDevice = new Map(
      assetRecords.map((r) => [r.deviceId, r.reportedVersion]),
    );

    const issues = [];
    const seen = new Set();
    const add = (category, deviceId, detail) => {
      const key = `${category}:${deviceId}`;
      if (seen.has(key)) return;
      seen.add(key);
      issues.push({ category, deviceId, ...detail });
    };

    // 每台设备取最新一条“有效固件”计划作为其应升目标
    const targetByDevice = this._expectedTargets();

    // 1) 漏升 + 2) 错升（以升级系统设备清单为准）
    for (const device of this.store.devices.values()) {
      const target = targetByDevice.get(device.deviceId);
      // 停在已作废版本上的设备归“回退/回退失败”口径，不重复计漏升
      const onRevokedFirmware =
        this.store.firmwares.get(device.currentVersion)?.status ===
        FirmwareStatus.REVOKED;
      if (
        target &&
        device.currentVersion !== target &&
        !onRevokedFirmware &&
        !this._underRollback(device.deviceId)
      ) {
        add(IssueCategory.MISSED, device.deviceId, {
          siteId: device.siteId,
          expectedVersion: target,
          actualVersion: device.currentVersion,
        });
      }

      if (!assetByDevice.has(device.deviceId)) {
        add(IssueCategory.WRONG_VERSION, device.deviceId, {
          siteId: device.siteId,
          assetVersion: null,
          actualVersion: device.currentVersion,
          reason: '资产系统缺少该设备记录',
        });
      } else {
        const assetVersion = assetByDevice.get(device.deviceId);
        if (assetVersion !== device.currentVersion) {
          add(IssueCategory.WRONG_VERSION, device.deviceId, {
            siteId: device.siteId,
            assetVersion,
            actualVersion: device.currentVersion,
            reason: '设备实际版本与资产系统记录不一致',
          });
        }
      }
    }

    // 2b) 资产系统有记录、但设备清单未登记（错升口径的资产侧异常）
    for (const [deviceId, reportedVersion] of assetByDevice) {
      if (!this.store.devices.has(deviceId)) {
        add(IssueCategory.WRONG_VERSION, deviceId, {
          siteId: null,
          assetVersion: reportedVersion,
          actualVersion: null,
          reason: '资产系统登记设备不在升级清单中',
        });
      }
    }

    // 3) 回退失败
    for (const order of this.store.orders.values()) {
      if (
        order.kind === OrderKind.ROLLBACK &&
        order.status === OrderStatus.FAILED
      ) {
        add(IssueCategory.ROLLBACK_FAILED, order.deviceId, {
          siteId: order.siteId,
          batchId: order.batchId,
          revokedVersion: order.baseVersion,
          rollbackToVersion: order.toVersion,
          error: order.error,
        });
      }
    }

    const weight = {
      [IssueCategory.ROLLBACK_FAILED]: 0,
      [IssueCategory.MISSED]: 1,
      [IssueCategory.WRONG_VERSION]: 2,
    };
    issues.sort(
      (a, b) =>
        weight[a.category] - weight[b.category] ||
        a.siteId?.localeCompare(b.siteId ?? '') ||
        a.deviceId.localeCompare(b.deviceId),
    );

    return {
      asOf: opts.asOf ?? new Date().toISOString(),
      totals: {
        devices: this.store.devices.size,
        assetRecords: assetRecords.length,
        missed: issues.filter((i) => i.category === IssueCategory.MISSED)
          .length,
        wrongVersion: issues.filter(
          (i) => i.category === IssueCategory.WRONG_VERSION,
        ).length,
        rollbackFailed: issues.filter(
          (i) => i.category === IssueCategory.ROLLBACK_FAILED,
        ).length,
      },
      issues,
    };
  }

  /**
   * 每台设备应升到的版本：取最新（createdAt 最大）一条
   * 目标固件仍有效的计划。目标固件已作废的计划不产生“漏升”义务，
   * 其回退问题走 ROLLBACK_FAILED 口径。
   */
  _expectedTargets() {
    const result = new Map();
    const plans = [...this.store.plans.values()]
      .filter((p) => this.store.firmwares.get(p.targetVersion)?.status === 'ACTIVE')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const plan of plans) {
      for (const deviceId of plan.deviceIds) {
        result.set(deviceId, plan.targetVersion);
      }
    }
    return result;
  }

  /** 设备仍处于回退流程中（已登记成功/在途/排队回退），不计漏升 */
  _underRollback(deviceId) {
    for (const o of this.store.orders.values()) {
      if (
        o.deviceId === deviceId &&
        o.kind === OrderKind.ROLLBACK &&
        o.status !== OrderStatus.FAILED
      ) {
        return true;
      }
    }
    return false;
  }
}
