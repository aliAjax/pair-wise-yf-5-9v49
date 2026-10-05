import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RolloutApp } from '../src/app.js';
import {
  BatchStatus,
  FirmwareStatus,
  OrderKind,
  OrderStatus,
} from '../src/constants.js';

function build() {
  const app = new RolloutApp();
  // A 站点容量 2，4 台设备；B 站点 1 台（用于已发布批次保持原样）
  app.registerSite({ siteId: 'site-a', capacity: 2 });
  app.registerSite({ siteId: 'site-b', capacity: 1 });
  for (const id of ['dev-1', 'dev-2', 'dev-3', 'dev-4']) {
    app.registerDevice({
      deviceId: id,
      siteId: 'site-a',
      currentVersion: 'v1.0',
    });
  }
  app.registerDevice({
    deviceId: 'dev-5',
    siteId: 'site-b',
    currentVersion: 'v1.0',
  });
  app.registerFirmware({ version: 'v2.0' });
  app.createPlan({
    planId: 'plan-1',
    targetVersion: 'v2.0',
    deviceIds: ['dev-1', 'dev-2', 'dev-3', 'dev-4', 'dev-5'],
  });
  return app;
}

const upgradeOf = (app, batchId, deviceId) =>
  app.ordersOfBatch(batchId).find(
    (o) => o.kind === OrderKind.UPGRADE && o.deviceId === deviceId,
  );

const rollbackOf = (app, batchId, deviceId) =>
  app.ordersOfBatch(batchId).find(
    (o) => o.kind === OrderKind.ROLLBACK && o.deviceId === deviceId,
  );

describe('固件作废：停批次 + 回退', () => {
  it('已发布批次保持原样，未跑完批次停住并回退已升设备', async () => {
    const app = build();

    // 1) dev-5 的批次先跑完并发布
    const b0 = app.createBatch('plan-1', ['dev-5'], { batchId: 'b0' });
    await app.startBatch('b0');
    await app.receiveReceipt(upgradeOf(app, 'b0', 'dev-5').commandId, {
      ok: true,
    });
    app.publishBatch('b0');
    assert.equal(app.getDevice('dev-5').currentVersion, 'v2.0');

    // 2) 主批次 4 台，容量 2：dev-1 成功，dev-2/dev-3 在途，dev-4 排队
    const b1 = app.createBatch(
      'plan-1',
      ['dev-1', 'dev-2', 'dev-3', 'dev-4'],
      { batchId: 'b1' },
    );
    await app.startBatch('b1');
    await app.receiveReceipt(upgradeOf(app, 'b1', 'dev-1').commandId, {
      ok: true,
    });
    assert.equal(app.getDevice('dev-1').currentVersion, 'v2.0');
    assert.equal(
      upgradeOf(app, 'b1', 'dev-4').status,
      OrderStatus.QUEUED,
    );

    // 3) 版本出事，作废
    const result = await app.revokeFirmware('v2.0');
    assert.deepEqual(result.haltedBatches, ['b1']);
    assert.equal(app.getBatch('b1').status, BatchStatus.HALTED);
    assert.equal(
      app.getBatch('b0').status,
      BatchStatus.PUBLISHED,
      '已发布批次保持原样',
    );
    assert.equal(
      app.getDevice('dev-5').currentVersion,
      'v2.0',
      '已发布设备不回退',
    );
    assert.equal(
      upgradeOf(app, 'b1', 'dev-4').status,
      OrderStatus.CANCELED,
      '排队指令取消',
    );
    const rb1 = rollbackOf(app, 'b1', 'dev-1');
    assert.ok(rb1, '已升设备登记回退');
    assert.equal(rb1.toVersion, 'v1.0', '回退到升级前版本');
    // 容量被 dev-2/dev-3 在途占满，回退先排队
    assert.equal(rb1.status, OrderStatus.QUEUED);

    // 作废后不能再圈批次
    assert.throws(
      () => app.createBatch('plan-1', ['dev-4'], { batchId: 'b2' }),
      /已作废/,
    );

    // 4) dev-2 的成功回执在作废后才到达：仍按指令落地，
    //    但因批次未发布，立即补登回退
    const dev2Up = upgradeOf(app, 'b1', 'dev-2');
    await app.receiveReceipt(dev2Up.commandId, { ok: true });
    assert.equal(app.getDevice('dev-2').currentVersion, 'v2.0');
    const rb2 = rollbackOf(app, 'b1', 'dev-2');
    assert.ok(rb2, '作废后才升级成功的设备同样登记回退');
    // 腾出一个槽位：回退按序先发 dev-1
    assert.equal(rb1.status, OrderStatus.DISPATCHED);
    assert.equal(rb2.status, OrderStatus.QUEUED);

    // 5) dev-3 回执失败：设备没升过，不登记回退
    await app.receiveReceipt(upgradeOf(app, 'b1', 'dev-3').commandId, {
      ok: false,
      error: '刷写失败',
    });
    assert.equal(app.getDevice('dev-3').currentVersion, 'v1.0');
    assert.equal(rollbackOf(app, 'b1', 'dev-3'), undefined);
    // dev-3 腾出槽位，dev-2 的回退下发
    assert.equal(rb2.status, OrderStatus.DISPATCHED);

    // 6) dev-1 回退成功
    await app.receiveReceipt(rb1.commandId, { ok: true });
    assert.equal(app.getDevice('dev-1').currentVersion, 'v1.0');

    // 7) dev-2 回退失败：进回退失败清单
    await app.receiveReceipt(rb2.commandId, {
      ok: false,
      error: '设备拒绝降级',
    });
    assert.equal(app.getDevice('dev-2').currentVersion, 'v2.0');
    const failed = app.listRollbackFailures();
    assert.equal(failed.length, 1);
    assert.equal(failed[0].deviceId, 'dev-2');
    assert.equal(failed[0].revokedVersion, 'v2.0');
    assert.equal(failed[0].rollbackToVersion, 'v1.0');

    // 批次不会因为后续回执“复活”为跑完
    assert.equal(app.getBatch('b1').status, BatchStatus.HALTED);
    assert.equal(
      app.store.firmwares.get('v2.0').status,
      FirmwareStatus.REVOKED,
    );
  });

  it('作废操作幂等：重复作废不重复登记回退', async () => {
    const app = build();
    app.createBatch('plan-1', ['dev-1'], { batchId: 'b1' });
    await app.startBatch('b1');
    await app.receiveReceipt(upgradeOf(app, 'b1', 'dev-1').commandId, {
      ok: true,
    });

    const r1 = await app.revokeFirmware('v2.0');
    const r2 = await app.revokeFirmware('v2.0');
    assert.equal(r1.rollbacks.length, 1);
    assert.equal(r2.rollbacks.length, 0, '重复作废不重复回退');
  });
});
