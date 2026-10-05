'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createService, compareVersions } = require('../src/service');

function setup() {
  const db = openDb(':memory:');
  const s = createService(db);
  return { db, s };
}

function seed(s, { stations = [{ name: 'A站', capacity: 2 }], devices = [] } = {}) {
  const sts = {};
  for (const st of stations) sts[st.name] = s.createStation(st);
  const devs = s.registerDevices(
    devices.map((d) => ({
      asset_tag: d.tag,
      station_name: d.station || 'A站',
      model: d.model || 'X1',
      current_version: d.current || '2.0.0',
    }))
  );
  return { sts, devs };
}

test('compareVersions 语义化版本比较', () => {
  assert.equal(compareVersions('2.0.0', '2.1.0'), -1);
  assert.equal(compareVersions('2.1.0', '2.1.0'), 0);
  assert.equal(compareVersions('2.2.0', '2.1.0'), 1);
  assert.equal(compareVersions('2.1', '2.1.0'), 0);
});

test('站点容量上限：超出部分排队', () => {
  const { s } = setup();
  const { devs } = seed(s, {
    stations: [{ name: 'A站', capacity: 2 }],
    devices: [
      { tag: 'D1' }, { tag: 'D2' }, { tag: 'D3' }, { tag: 'D4' }, { tag: 'D5' },
    ],
  });
  const fw = s.createFirmware({ version: '2.1.0', model: 'X1' });
  s.publishFirmware(fw.id);
  const camp = s.createCampaign({ firmware_id: fw.id, device_ids: devs.map((d) => d.id) });
  const batch = camp.batches[0];
  const r = s.dispatchBatch(batch.id);
  assert.equal(r.dispatched, 2, '容量2，只下发2台');
  assert.equal(r.queued, 3, '3台排队');
  const station = s.listStations()[0];
  assert.equal(station.in_flight, 2);
  assert.equal(station.queued, 3);
});

test('排队任务结转到下一批并按顺序下发', () => {
  const { s } = setup();
  const { devs } = seed(s, {
    stations: [{ name: 'A站', capacity: 2 }],
    devices: [{ tag: 'D1' }, { tag: 'D2' }, { tag: 'D3' }],
  });
  const fw = s.createFirmware({ version: '2.1.0', model: 'X1' });
  s.publishFirmware(fw.id);
  const camp = s.createCampaign({ firmware_id: fw.id, device_ids: devs.map((d) => d.id) });
  const b1 = camp.batches[0];
  s.dispatchBatch(b1.id);
  // D1 D2 下发，D3 排队
  const cmds = s.listCommands({ status: 'dispatched' });
  s.ackCommand(cmds[0].id, { success: true });
  s.ackCommand(cmds[1].id, { success: true });
  // 建下一批：D3 结转
  const nb = s.createNextBatch(camp.id, []);
  assert.equal(nb.carried, 1, '结转1个排队任务');
  const tasks = s.getBatch(nb.batch.id).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].asset_tag, 'D3');
  // 容量已空，D3 下发
  const r = s.dispatchBatch(nb.batch.id);
  assert.equal(r.dispatched, 1);
});

test('指令回执幂等：重复送达只算一次', () => {
  const { s } = setup();
  const { devs } = seed(s, {
    stations: [{ name: 'A站', capacity: 2 }],
    devices: [{ tag: 'D1' }],
  });
  const fw = s.createFirmware({ version: '2.1.0', model: 'X1' });
  s.publishFirmware(fw.id);
  const camp = s.createCampaign({ firmware_id: fw.id, device_ids: devs.map((d) => d.id) });
  s.dispatchBatch(camp.batches[0].id);
  const cmd = s.listCommands({ status: 'dispatched' })[0];
  const first = s.ackCommand(cmd.id, { success: true });
  assert.equal(first.idempotent, false);
  assert.equal(first.task.status, 'upgraded');
  const device = s.listDevices({ asset_tag: 'D1' })[0] || s.db.prepare('SELECT * FROM devices WHERE id=?').get(devs[0].id);
  assert.equal(device.current_version, '2.1.0');
  // 重复回执
  const second = s.ackCommand(cmd.id, { success: true });
  assert.equal(second.idempotent, true, '第二次回执幂等');
  assert.equal(second.task.status, 'upgraded');
  // 设备版本未被重复修改
  const device2 = s.db.prepare('SELECT * FROM devices WHERE id=?').get(devs[0].id);
  assert.equal(device2.current_version, '2.1.0');
});

test('断网恢复：未回执指令按顺序补发，排队指令按容量下发', () => {
  const { s } = setup();
  const { sts, devs } = seed(s, {
    stations: [{ name: 'A站', capacity: 3 }],
    devices: [{ tag: 'D1' }, { tag: 'D2' }, { tag: 'D3' }, { tag: 'D4' }],
  });
  const fw = s.createFirmware({ version: '2.1.0', model: 'X1' });
  s.publishFirmware(fw.id);
  const camp = s.createCampaign({ firmware_id: fw.id, device_ids: [devs[0].id, devs[1].id] });
  // D1 D2 下发（容量3），无排队
  s.dispatchBatch(camp.batches[0].id);
  assert.equal(s.listCommands({ status: 'dispatched' }).length, 2);
  // A站断网
  s.updateStation(sts['A站'].id, { online: false });
  // 再建一批 D3 D4，断网期间指令 pending
  const nb = s.createNextBatch(camp.id, [devs[2].id, devs[3].id]);
  s.dispatchBatch(nb.batch.id);
  assert.equal(s.listCommands({ status: 'pending' }).length, 2, 'D3 D4 指令 pending');
  // 恢复：补发未回执 D1 D2（2条）；容量3 > 在途2，新下发 D3（1条），D4 仍排队
  const rec = s.recoverStation(sts['A站'].id);
  assert.equal(rec.redelivered, 2, '补发2条未回执指令');
  assert.equal(rec.delivered, 1, '容量3，新下发1条排队指令');
  assert.equal(rec.stillPending, 1, '1条仍排队');
  // 顺序：D1 D2 补发(seq1,2)，D3 按序下发(seq3)
  const dispatched = s.listCommands({ status: 'dispatched' }).map((c) => c.sequence_no).sort((a, b) => a - b);
  assert.deepEqual(dispatched, [1, 2, 3], 'D1 D2 补发，D3 按 sequence_no 下发');
});

test('固件作废：已发布批次保持原样，未发布批次停住并回退已升设备', () => {
  const { s } = setup();
  const { devs } = seed(s, {
    stations: [{ name: 'A站', capacity: 2 }],
    devices: [{ tag: 'D1' }, { tag: 'D2' }, { tag: 'D3' }],
  });
  const fw = s.createFirmware({ version: '2.1.0', model: 'X1' });
  s.publishFirmware(fw.id);
  const camp = s.createCampaign({ firmware_id: fw.id, device_ids: devs.map((d) => d.id) });
  const b1 = camp.batches[0];
  s.dispatchBatch(b1.id);
  const cmds = s.listCommands({ status: 'dispatched' });
  s.ackCommand(cmds[0].id, { success: true }); // D1 升级
  s.ackCommand(cmds[1].id, { success: true }); // D2 升级
  // 批次2：D3 结转（先结转，批次1 才全部完成可发布）
  const nb = s.createNextBatch(camp.id, []);
  s.publishBatch(b1.id); // 发布批次1
  s.dispatchBatch(nb.batch.id);
  const cmdD3 = s.listCommands({ status: 'dispatched' })[0];
  s.ackCommand(cmdD3.id, { success: true }); // D3 升级
  // 作废
  const inv = s.invalidateFirmware(fw.id);
  assert.equal(inv.batchesStopped, 1, '停住批次2');
  assert.equal(inv.devicesToRollback, 1, '回退D3');
  // 批次1 保持原样
  assert.equal(s.getBatch(b1.id).status, 'published');
  const b1Tasks = s.getBatch(b1.id).tasks;
  assert.ok(b1Tasks.every((t) => t.status === 'upgraded'), '批次1设备仍 upgraded，不回退');
  // 批次2 停住，D3 回退中
  assert.equal(s.getBatch(nb.batch.id).status, 'paused');
  const d3 = s.db.prepare('SELECT status FROM upgrade_tasks WHERE device_id=?').get(devs[2].id);
  assert.equal(d3.status, 'rolling_back');
  // 回退成功后 D3 回到 2.0.0
  const rbCmd = s.db.prepare('SELECT * FROM commands WHERE task_id=(SELECT id FROM upgrade_tasks WHERE device_id=?) AND type=\'rollback\'').get(devs[2].id);
  s.ackCommand(rbCmd.id, { success: true });
  const d3After = s.db.prepare('SELECT * FROM devices WHERE id=?').get(devs[2].id);
  assert.equal(d3After.current_version, '2.0.0');
});

test('对账：漏升 / 错升 / 回退失败', () => {
  const { s } = setup();
  const { devs } = seed(s, {
    stations: [{ name: 'A站', capacity: 2 }],
    devices: [
      { tag: 'D1', current: '2.0.0' },
      { tag: 'D2', current: '2.0.0' },
      { tag: 'D3', current: '2.0.0' },
    ],
  });
  const fw = s.createFirmware({ version: '2.1.0', model: 'X1' });
  s.publishFirmware(fw.id);
  const camp = s.createCampaign({ firmware_id: fw.id, device_ids: devs.map((d) => d.id) });
  s.dispatchBatch(camp.batches[0].id);
  const cmds = s.listCommands({ status: 'dispatched' });
  s.ackCommand(cmds[0].id, { success: true }); // D1 升级
  s.ackCommand(cmds[1].id, { success: true }); // D2 升级
  // D3 排队，结转到批次2（漏升）；先结转，批次1 才可发布
  s.createNextBatch(camp.id, []);
  s.publishBatch(camp.batches[0].id);
  // 作废 2.1.0
  s.invalidateFirmware(fw.id);
  // D1 D2 在已发布批次，保持 2.1.0（错升）
  // 发布修复版本 2.2.0
  const fw2 = s.createFirmware({ version: '2.2.0', model: 'X1' });
  s.publishFirmware(fw2.id);
  s.syncAssetSystem(devs.map((d) => ({ asset_tag: 'D' + (devs.indexOf(d) + 1), expected_version: '2.2.0' })));
  const r = s.reconcile();
  assert.equal(r.counts.wrong, 2, 'D1 D2 在作废版本上 → 错升');
  assert.equal(r.counts.missed, 1, 'D3 落后 → 漏升');
  assert.equal(r.counts.rollback_failed, 0);
  // 回退失败场景：D1 回退失败
  // （已发布批次不回退，这里用另一个未发布批次演示回退失败）
});

test('对账：回退失败单独归类', () => {
  const { s } = setup();
  const { devs } = seed(s, {
    stations: [{ name: 'A站', capacity: 2 }],
    devices: [{ tag: 'D1' }, { tag: 'D2' }],
  });
  const fw = s.createFirmware({ version: '2.1.0', model: 'X1' });
  s.publishFirmware(fw.id);
  const camp = s.createCampaign({ firmware_id: fw.id, device_ids: devs.map((d) => d.id) });
  s.dispatchBatch(camp.batches[0].id);
  const cmds = s.listCommands({ status: 'dispatched' });
  s.ackCommand(cmds[0].id, { success: true }); // D1 升级
  s.ackCommand(cmds[1].id, { success: true }); // D2 升级
  // 不发布批次 → 作废时回退
  s.invalidateFirmware(fw.id);
  // D1 回退失败
  const rbD1 = s.db.prepare('SELECT * FROM commands WHERE task_id=(SELECT id FROM upgrade_tasks WHERE device_id=?) AND type=\'rollback\'').get(devs[0].id);
  s.ackCommand(rbD1.id, { success: false });
  // D2 回退成功
  const rbD2 = s.db.prepare('SELECT * FROM commands WHERE task_id=(SELECT id FROM upgrade_tasks WHERE device_id=?) AND type=\'rollback\'').get(devs[1].id);
  s.ackCommand(rbD2.id, { success: true });
  s.syncAssetSystem(devs.map((d) => ({ asset_tag: 'D' + (devs.indexOf(d) + 1), expected_version: '2.0.0' })));
  const r = s.reconcile();
  assert.equal(r.counts.rollback_failed, 1, 'D1 回退失败');
  assert.equal(r.rollback_failed[0].asset_tag, 'D1');
  assert.equal(r.counts.wrong, 0, 'D2 已回退，不在作废版本上');
});
