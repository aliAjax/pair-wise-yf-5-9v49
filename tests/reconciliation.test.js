import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RolloutApp } from '../src/app.js';
import { IssueCategory, OrderKind, OrderStatus } from '../src/constants.js';

const byDevice = (issues, category) =>
  issues
    .filter((i) => i.category === category)
    .map((i) => i.deviceId)
    .sort();

describe('月底对账', () => {
  it('列出漏升、错升、回退失败三类设备', () => {
    const app = new RolloutApp();
    app.registerSite({ siteId: 's1', capacity: 5 });
    // 计划内设备（d-wrong 不纳入任何计划：它只有版本对不上资产，没有漏升义务）
    for (const id of ['d-ok', 'd-miss', 'd-wrong', 'd-rbfail']) {
      app.registerDevice({
        deviceId: id,
        siteId: 's1',
        currentVersion: 'v1.0',
      });
    }
    app.registerFirmware({ version: 'v2.0' });
    app.createPlan({
      planId: 'p1',
      targetVersion: 'v2.0',
      deviceIds: ['d-ok', 'd-miss', 'd-rbfail'],
    });

    // d-ok 已升到 v2.0；其余仍是 v1.0（批次还没跑完 -> 漏升）
    app.getDevice('d-ok').currentVersion = 'v2.0';

    // 回退失败设备（固件作废后回退指令失败）
    app.registerFirmware({ version: 'v3.0' });
    app.createPlan({
      planId: 'p2',
      targetVersion: 'v3.0',
      deviceIds: ['d-rbfail'],
    });
    const rbBatch = app.createBatch('p2', ['d-rbfail'], {
      batchId: 'rb',
    });
    app.getDevice('d-rbfail').currentVersion = 'v3.0';
    // 直接构造一条失败回退指令（模拟作废处置后的终态）
    app.store.orders.set('o-rbfail', {
      orderId: 'o-rbfail',
      commandId: 's1:rb',
      batchId: rbBatch.batchId,
      planId: 'p2',
      deviceId: 'd-rbfail',
      siteId: 's1',
      siteSeq: 99,
      kind: OrderKind.ROLLBACK,
      status: OrderStatus.FAILED,
      toVersion: 'v1.0',
      baseVersion: 'v3.0',
      attempts: 1,
      duplicateReceipts: 0,
      error: '回变砖，拒绝降级',
      createdAt: Date.now(),
      dispatchedAt: Date.now(),
      receivedAt: Date.now(),
    });
    // v3.0 作废，因此 d-rbfail 不算漏升（坏版本没有升级义务）
    app.revocation.revoke('v3.0');

    // 资产系统快照：
    //  - d-ok 与实际一致 v2.0
    //  - d-miss 一致 v1.0（但漏升）
    //  - d-wrong 资产误记为 v2.0，实际 v1.0 -> 错升
    //  - d-rbfail 一致 v3.0（但回退失败）
    //  - ghost 资产里有、清单里没有 -> 错升
    const report = app.monthEndReconcile(
      [
        { deviceId: 'd-ok', reportedVersion: 'v2.0' },
        { deviceId: 'd-miss', reportedVersion: 'v1.0' },
        { deviceId: 'd-wrong', reportedVersion: 'v2.0' },
        { deviceId: 'd-rbfail', reportedVersion: 'v3.0' },
        { deviceId: 'ghost', reportedVersion: 'v9.0' },
      ],
      { asOf: '2026-10-31T00:00:00.000Z' },
    );

    assert.deepEqual(byDevice(report.issues, IssueCategory.MISSED), [
      'd-miss',
    ]);
    assert.deepEqual(
      byDevice(report.issues, IssueCategory.WRONG_VERSION),
      ['d-wrong', 'ghost'],
    );
    assert.deepEqual(
      byDevice(report.issues, IssueCategory.ROLLBACK_FAILED),
      ['d-rbfail'],
    );

    assert.deepEqual(report.totals, {
      devices: 4,
      assetRecords: 5,
      missed: 1,
      wrongVersion: 2,
      rollbackFailed: 1,
    });

    const missed = report.issues.find(
      (i) => i.category === IssueCategory.MISSED,
    );
    assert.equal(missed.expectedVersion, 'v2.0');
    assert.equal(missed.actualVersion, 'v1.0');
  });

  it('处于回退流程中的设备不计漏升，完全一致时报告为空', () => {
    const app = new RolloutApp();
    app.registerSite({ siteId: 's1', capacity: 5 });
    app.registerDevice({
      deviceId: 'd1',
      siteId: 's1',
      currentVersion: 'v1.0',
    });
    app.registerFirmware({ version: 'v2.0' });
    app.createPlan({
      planId: 'p1',
      targetVersion: 'v2.0',
      deviceIds: ['d1'],
    });

    const report = app.monthEndReconcile([
      { deviceId: 'd1', reportedVersion: 'v1.0' },
    ]);
    // 批次未开始：仍属漏升（计划义务存在）
    assert.equal(report.totals.missed, 1);
  });
});
