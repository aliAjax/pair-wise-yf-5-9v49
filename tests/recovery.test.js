import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RolloutApp } from '../src/app.js';
import { OrderStatus } from '../src/constants.js';

function setup({ capacity = 2, deviceCount = 2 } = {}) {
  const app = new RolloutApp();
  app.registerSite({ siteId: 'site-a', capacity });
  const deviceIds = [];
  for (let i = 1; i <= deviceCount; i++) {
    const id = `dev-${i}`;
    app.registerDevice({
      deviceId: id,
      siteId: 'site-a',
      currentVersion: 'v1.0',
    });
    deviceIds.push(id);
  }
  app.registerFirmware({ version: 'v2.0' });
  app.createPlan({
    planId: 'plan-1',
    targetVersion: 'v2.0',
    deviceIds,
  });
  app.createBatch('plan-1', deviceIds, { batchId: 'b1' });
  return { app, deviceIds };
}

describe('断网恢复与指令幂等', () => {
  it('恢复后按站点序号顺序补发未回执指令', async () => {
    const { app, deviceIds } = setup();
    await app.startBatch('b1');
    const orders = app.ordersOfBatch('b1').sort(
      (a, b) => a.siteSeq - b.siteSeq,
    );
    assert.deepEqual(
      orders.map((o) => o.deviceId),
      deviceIds,
    );

    // 断网期间两条指令都没有回执
    app.siteOffline('site-a');

    // 恢复时记录补发顺序
    const resentOrder = [];
    const origSend = app.gateway.sendCommand.bind(app.gateway);
    app.gateway.sendCommand = async (order) => {
      const r = await origSend(order);
      resentOrder.push(order.commandId);
      return r;
    };

    const { resent } = await app.siteRecover('site-a');
    assert.equal(resent.length, 2, '两条未回执指令全部补发');
    assert.deepEqual(
      resentOrder,
      orders.map((o) => o.commandId),
      '按站点序号从小到大补发',
    );
    assert.ok(resent.every((o) => o.attempts === 2), '补发尝试次数 +1');
    assert.equal(app.gateway.deliveryTimes(orders[0].commandId), 2);
  });

  it('同一指令重复回执只算一次', async () => {
    const { app } = setup();
    await app.startBatch('b1');
    const [first] = app.ordersOfBatch('b1');

    const r1 = await app.receiveReceipt(first.commandId, { ok: true });
    assert.equal(r1.accepted, true);
    assert.equal(app.getDevice(first.deviceId).currentVersion, 'v2.0');

    // 设备重传同一条成功回执
    const r2 = await app.receiveReceipt(first.commandId, { ok: true });
    assert.equal(r2.accepted, false, '重复回执不接受');
    assert.equal(r2.duplicate, true);
    assert.equal(first.duplicateReceipts, 1);
    assert.equal(app.getDevice(first.deviceId).currentVersion, 'v2.0');

    // 伪装成失败的重复回执也不能改写结果
    const r3 = await app.receiveReceipt(first.commandId, {
      ok: false,
      error: 'later failure',
    });
    assert.equal(r3.accepted, false);
    assert.equal(first.status, OrderStatus.SUCCESS);
    assert.equal(app.getDevice(first.deviceId).currentVersion, 'v2.0');
  });

  it('未知 commandId 回执报错', async () => {
    const { app } = setup();
    await assert.rejects(
      () => app.receiveReceipt('site-a:999', { ok: true }),
      /指令 不存在/,
    );
  });
});
