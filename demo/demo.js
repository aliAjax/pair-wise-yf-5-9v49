/**
 * 端到端演示：登记资产 -> 批次灰度 -> 站点断网恢复 ->
 * 固件作废停批次回退 -> 月底对账。
 *
 * 运行：npm run demo
 */
import {
  BatchStatus,
  IssueCategory,
  OrderKind,
  RolloutApp,
} from '../src/index.js';

const LINE = '─'.repeat(72);

function assertCanceled(order) {
  if (order.status !== 'CANCELED') {
    throw new Error(`期望 ${order.deviceId} 排队指令被取消，实际 ${order.status}`);
  }
}

function log(title, body) {
  console.log(`\n${LINE}\n▶ ${title}\n${LINE}`);
  if (body !== undefined) console.log(body);
}

function describeOrders(app, batchId) {
  return app
    .ordersOfBatch(batchId)
    .map((o) => {
      const kind = o.kind === OrderKind.UPGRADE ? '升级' : '回退';
      const statusMap = {
        QUEUED: '排队',
        DISPATCHED: '在途',
        SUCCESS: '成功',
        FAILED: '失败',
        CANCELED: '取消',
      };
      return `    ${o.deviceId} ${kind}→${o.toVersion} ` +
        `${statusMap[o.status]} (cmd ${o.commandId}, 送达${app.gateway.deliveryTimes(o.commandId)}次)`;
    })
    .join('\n');
}

async function main() {
  const app = new RolloutApp();

  // ---------- 1. 登记站点 / 设备 / 固件 / 计划 ----------
  log('1. 登记资产清单');
  app.registerSite({ siteId: 'BJ', name: '北京站点', capacity: 2 });
  app.registerSite({ siteId: 'SH', name: '上海站点', capacity: 1 });

  for (const id of ['BJ-01', 'BJ-02', 'BJ-03', 'BJ-05', 'BJ-06']) {
    app.registerDevice({ deviceId: id, siteId: 'BJ', currentVersion: 'v1.0' });
  }
  app.registerDevice({ deviceId: 'SH-01', siteId: 'SH', currentVersion: 'v1.0' });
  app.registerDevice({ deviceId: 'BJ-04', siteId: 'BJ', currentVersion: 'v1.0' });
  app.registerFirmware({ version: 'v2.0' });
  app.registerFirmware({ version: 'v2.1' });
  const plan = app.createPlan({
    planId: 'plan-v2',
    name: '全网 v2.0 灰度',
    targetVersion: 'v2.0',
    deviceIds: ['BJ-01', 'BJ-02', 'BJ-03', 'BJ-05', 'BJ-06', 'SH-01'],
  });
  // BJ-04 属于后续有效固件 v2.1 的计划，但到月底批次都没跑起来 -> 漏升
  app.createPlan({
    planId: 'plan-v21',
    name: '全网 v2.1 灰度',
    targetVersion: 'v2.1',
    deviceIds: ['BJ-04'],
  });
  console.log('  站点：北京(容量2) / 上海(容量1)');
  console.log('  设备：BJ-01..06、SH-01，当前版本均为 v1.0');
  console.log(`  计划：${plan.planId} -> ${plan.targetVersion}；plan-v21 -> v2.1（BJ-04）`);

  // ---------- 2. 第一批：北京 3 台，容量 2 ----------
  log('2. 批次 B1 圈选北京 5 台并启动（容量 2，超出排队）');
  app.createBatch(
    'plan-v2',
    ['BJ-01', 'BJ-02', 'BJ-03', 'BJ-05', 'BJ-06'],
    { batchId: 'B1' },
  );
  await app.startBatch('B1');
  console.log(describeOrders(app, 'B1'));
  console.log('  → BJ-01、BJ-02 在途，BJ-03、BJ-05、BJ-06 排队等槽位');

  // ---------- 3. 站点断网恢复：未回执指令顺序补发 ----------
  log('3. 北京站点断网 30 秒后恢复，未回执指令按顺序补发');
  app.siteOffline('BJ');
  console.log('  站点状态：断网（两条在途指令均无回执）');
  const { resent } = await app.siteRecover('BJ');
  console.log(
    '  恢复后补发顺序：' +
      resent.map((o) => `${o.deviceId}(${o.commandId})`).join(' → '),
  );

  // ---------- 4. 回执：BJ-01 成功，BJ-03 补位；BJ-02 重传回执 ----------
  log('4. 设备回执（BJ-02 网络重传，同一指令送回两次）');
  const b1 = app.ordersOfBatch('B1');
  await app.receiveReceipt(b1[0].commandId, { ok: true });
  console.log(`  BJ-01 升级成功，当前版本 ${app.getDevice('BJ-01').currentVersion}`);
  const bj03After = app
    .ordersOfBatch('B1')
    .find((o) => o.deviceId === 'BJ-03');
  console.log(
    `  BJ-03 补位：${bj03After.kind === 'UPGRADE' ? '升级' : '回退'}` +
      `→${bj03After.toVersion} 状态 ${bj03After.status}`,
  );

  const bj02 = b1[1];
  await app.receiveReceipt(bj02.commandId, { ok: true });
  const dup = await app.receiveReceipt(bj02.commandId, { ok: true });
  console.log(
    `  BJ-02 回执成功；重传回执 accepted=${dup.accepted}（重复只算一次），` +
      `当前版本 ${app.getDevice('BJ-02').currentVersion}`,
  );

  // ---------- 5. 第二批：上海 1 台，跑完并发布 ----------
  log('5. 批次 B2 圈选上海 1 台，跑完并发布');
  app.createBatch('plan-v2', ['SH-01'], { batchId: 'B2' });
  await app.startBatch('B2');
  const shOrder = app.ordersOfBatch('B2')[0];
  await app.receiveReceipt(shOrder.commandId, { ok: true });
  app.publishBatch('B2');
  console.log(
    `  SH-01 已升到 ${app.getDevice('SH-01').currentVersion}，` +
      `批次状态 ${BatchStatus.PUBLISHED}`,
  );

  // BJ-03、BJ-05 已补位在途，BJ-06 始终排队
  const bj03 = app.ordersOfBatch('B1').find((o) => o.deviceId === 'BJ-03');
  const bj05 = app.ordersOfBatch('B1').find((o) => o.deviceId === 'BJ-05');
  const bj06 = app.ordersOfBatch('B1').find((o) => o.deviceId === 'BJ-06');

  // ---------- 6. 固件 v2.0 出事作废 ----------
  log('6. v2.0 线上出事，立即作废');
  const revoked = await app.revokeFirmware('v2.0');
  console.log(`  停住的批次：${revoked.haltedBatches.join(', ')}（B2 已发布，保持原样）`);
  console.log(`  已升设备：BJ-01、BJ-02 各登记一条回退指令（回 v1.0）`);
  console.log(`  BJ-03、BJ-05 已补位在途，批次停住后等其回执（未升则无需回退）`);
  console.log(`  BJ-06 从未下发，排队指令直接取消`);
  console.log(describeOrders(app, 'B1'));

  // 在途升级占满容量，回退先排队；失败回执腾出槽位后回退按序下发
  await app.receiveReceipt(bj03.commandId, {
    ok: false,
    error: '版本已作废，设备拒绝刷入',
  });
  await app.receiveReceipt(bj05.commandId, {
    ok: false,
    error: '版本已作废，设备拒绝刷入',
  });
  assertCanceled(bj06);
  console.log(`\n  BJ-03、BJ-05 失败回执（设备未升过，无需回退），槽位释放后：`);
  console.log(describeOrders(app, 'B1'));

  // ---------- 7. 回退：BJ-01 成功，BJ-02 失败 ----------
  log('7. 回退执行：BJ-01 成功，BJ-02 回退失败');
  const rollbacks = app
    .ordersOfBatch('B1')
    .filter((o) => o.kind === OrderKind.ROLLBACK);
  await app.receiveReceipt(rollbacks[0].commandId, { ok: true });
  await app.receiveReceipt(rollbacks[1].commandId, {
    ok: false,
    error: '设备拒绝降级，停在 v2.0',
  });
  for (const id of ['BJ-01', 'BJ-02', 'BJ-03', 'BJ-05', 'BJ-06', 'BJ-04', 'SH-01']) {
    console.log(`    ${id} 当前版本：${app.getDevice(id).currentVersion}`);
  }
  console.log('  回退失败清单：');
  for (const f of app.listRollbackFailures()) {
    console.log(
      `    ${f.deviceId} @ ${f.siteId} 应回 ${f.rollbackToVersion}：${f.error}`,
    );
  }

  // ---------- 8. 月底对账 ----------
  log('8. 月底与资产系统对账');
  // 资产系统快照（设备上报版本）
  const assetRecords = [
    { deviceId: 'BJ-01', reportedVersion: 'v1.0' }, // 已回退，一致
    { deviceId: 'BJ-02', reportedVersion: 'v2.0' }, // 回退失败，版本本身一致
    { deviceId: 'BJ-03', reportedVersion: 'v1.0' }, // 批次停在作废版本上，不重复计漏升
    { deviceId: 'BJ-05', reportedVersion: 'v1.0' }, // 同上
    { deviceId: 'BJ-06', reportedVersion: 'v1.0' }, // 同上（排队指令被取消）
    { deviceId: 'BJ-04', reportedVersion: 'v1.0' }, // 资产一致但漏升（v2.1 计划未跑）
    { deviceId: 'SH-01', reportedVersion: 'v1.0' }, // 已发布 v2.0，资产误记 v1.0 -> 错升
    { deviceId: 'GHOST-99', reportedVersion: 'v9.0' }, // 资产有、清单没有
  ];
  const report = app.monthEndReconcile(assetRecords, {
    asOf: '2026-10-31T00:00:00.000Z',
  });

  const label = {
    [IssueCategory.MISSED]: '漏升',
    [IssueCategory.WRONG_VERSION]: '错升',
    [IssueCategory.ROLLBACK_FAILED]: '回退失败',
  };
  for (const issue of report.issues) {
    console.log(
      `  [${label[issue.category]}] ${issue.deviceId}` +
        (issue.expectedVersion
          ? ` 应升 ${issue.expectedVersion} 实际 ${issue.actualVersion}`
          : '') +
        (issue.reason ? `：${issue.reason}` : '') +
        (issue.rollbackToVersion
          ? `，应回 ${issue.rollbackToVersion}：${issue.error ?? ''}`
          : '') +
        (issue.assetVersion !== undefined && !issue.expectedVersion
          ? ` 资产=${issue.assetVersion ?? '缺失'} 实际=${issue.actualVersion ?? '缺失'}`
          : ''),
    );
  }
  console.log(
    `\n  汇总：漏升 ${report.totals.missed} 台，错升 ` +
      `${report.totals.wrongVersion} 台，回退失败 ${report.totals.rollbackFailed} 台`,
  );

  console.log(`\n${LINE}\n演示结束\n${LINE}`);
}

main().catch((err) => {
  console.error('演示失败:', err);
  process.exit(1);
});
