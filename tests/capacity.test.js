import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RolloutApp } from '../src/app.js';
import { BatchStatus, OrderStatus } from '../src/constants.js';

/** 构造标准测试环境：1 个站点 + 若干设备（初始版本 v1.0） */
function setup({ capacity = 2, deviceCount = 3 } = {}) {
  const app = new RolloutApp();
  const site = app.registerSite({
    siteId: 'site-a',
    name: 'A 站点',
    capacity,
  });
  const deviceIds = [];
  for (let i = 1; i <= deviceCount; i++) {
    const id = `dev-${i}`;
    app.registerDevice({
      deviceId: id,
      siteId: site.siteId,
      currentVersion: 'v1.0',
    });
    deviceIds.push(id);
  }
  app.registerFirmware({ version: 'v2.0' });
  const plan = app.createPlan({
    planId: 'plan-1',
    targetVersion: 'v2.0',
    deviceIds,
  });
  return { app, site, deviceIds, plan };
}

describe('站点容量与排队下发', () => {
  it('容量只允许同时在途 N 条，超出的排队，回执后自动补位', async () => {
    const { app, deviceIds } = setup({ capacity: 2, deviceCount: 3 });
    const batch = app.createBatch('plan-1', deviceIds, {
      batchId: 'b1',
    });
    await app.startBatch('b1');

    let orders = app.ordersOfBatch('b1');
    assert.equal(
      orders.filter((o) => o.status === OrderStatus.DISPATCHED).length,
      2,
      '容量 2：前两条在途',
    );
    assert.equal(orders[2].status, OrderStatus.QUEUED, '第三条排队');

    // 第一条回执成功 -> 腾出槽位 -> 第三条自动补位下发
    await app.receiveReceipt(orders[0].commandId, { ok: true });
    orders = app.ordersOfBatch('b1');
    assert.equal(app.getDevice(deviceIds[0]).currentVersion, 'v2.0');
    assert.equal(orders[2].status, OrderStatus.DISPATCHED, '排队指令补位');

    await app.receiveReceipt(orders[1].commandId, { ok: true });
    // 第三条此时也在途，回执后批次跑完
    await app.receiveReceipt(orders[2].commandId, { ok: true });

    assert.equal(app.getBatch('b1').status, BatchStatus.COMPLETED);
    app.publishBatch('b1');
    assert.equal(app.getBatch('b1').status, BatchStatus.PUBLISHED);
  });

  it('启动时断网则全部排队，恢复后自动下发', async () => {
    const { app, deviceIds } = setup({ capacity: 2, deviceCount: 2 });
    app.createBatch('plan-1', deviceIds, { batchId: 'b-offline' });

    app.siteOffline('site-a');
    await app.startBatch('b-offline');
    let orders = app.ordersOfBatch('b-offline');
    assert.ok(
      orders.every((o) => o.status === OrderStatus.QUEUED),
      '断网期间全部排队',
    );

    await app.siteRecover('site-a');
    orders = app.ordersOfBatch('b-offline');
    assert.equal(
      orders.filter((o) => o.status === OrderStatus.DISPATCHED).length,
      2,
      '恢复后按容量下发',
    );
  });

  it('同一设备不能被圈进两个未结束批次', () => {
    const { app, deviceIds } = setup({ capacity: 2, deviceCount: 3 });
    app.createBatch('plan-1', [deviceIds[0]], { batchId: 'b-x' });
    assert.throws(
      () => app.createBatch('plan-1', [deviceIds[0]], { batchId: 'b-y' }),
      /不能重复圈选/,
    );
  });

  it('未跑完的批次不能发布', async () => {
    const { app, deviceIds } = setup({ capacity: 2, deviceCount: 1 });
    app.createBatch('plan-1', deviceIds, { batchId: 'b-p' });
    await app.startBatch('b-p');
    assert.throws(() => app.publishBatch('b-p'), /只有跑完的批次/);
  });
});
