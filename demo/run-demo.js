'use strict';

/*
 * 灰度升级服务 · 端到端演示
 *
 * 覆盖需求：
 *  1. 登记设备清单，按批次圈设备下发升级
 *  2. 每个站点容量有上限，超出的排队等下一批
 *  3. 站点断网恢复后，先把下发没回执的指令按顺序补发；同一指令重复送回只算一次（幂等）
 *  4. 固件作废：没跑完的批次停住、已升级设备回退；已发布批次保持原样
 *  5. 月底与资产系统对账：列出漏升、错升、回退失败的设备
 */

const path = require('path');
const fs = require('fs');
const { openDb } = require('../src/db');
const { createService } = require('../src/service');

const DB_PATH = path.join(__dirname, '..', 'data', 'demo.db');
if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH);

const db = openDb(DB_PATH);
const s = createService(db);

let step = 0;
function title(t) { console.log(`\n${'='.repeat(70)}\n${++step}. ${t}\n${'='.repeat(70)}`); }
function log(label, v) { console.log(`  ${label}:`, typeof v === 'object' ? JSON.stringify(v) : v); }
function taskTable(tasks) {
  for (const t of tasks) {
    console.log(`    #${t.id} ${t.asset_tag}@${t.station_name}  seq=${t.sequence_no}  ${t.from_version} -> ${t.to_version}  [${t.status}]`);
  }
}

title('登记站点与设备清单');
const A = s.createStation({ name: 'A站', capacity: 2 });
const B = s.createStation({ name: 'B站', capacity: 2 });
const C = s.createStation({ name: 'C站', capacity: 1 });
log('站点', s.listStations().map((x) => `${x.name}(容量${x.capacity})`).join(' '));

const devs = s.registerDevices([
  { asset_tag: 'D01', station_name: 'A站', model: 'X1', current_version: '2.0.0' },
  { asset_tag: 'D02', station_name: 'A站', model: 'X1', current_version: '2.0.0' },
  { asset_tag: 'D03', station_name: 'A站', model: 'X1', current_version: '2.0.0' },
  { asset_tag: 'D04', station_name: 'A站', model: 'X1', current_version: '2.0.0' },
  { asset_tag: 'D05', station_name: 'A站', model: 'X1', current_version: '2.0.0' },
  { asset_tag: 'D06', station_name: 'B站', model: 'X1', current_version: '2.0.0' },
  { asset_tag: 'D07', station_name: 'B站', model: 'X1', current_version: '2.0.0' },
  { asset_tag: 'D08', station_name: 'B站', model: 'X1', current_version: '2.0.0' },
  { asset_tag: 'D09', station_name: 'B站', model: 'X1', current_version: '2.0.0' },
  { asset_tag: 'D10', station_name: 'C站', model: 'X1', current_version: '2.0.0' },
  { asset_tag: 'D11', station_name: 'C站', model: 'X1', current_version: '2.0.0' },
]);
log('设备数', devs.length);

title('创建并发布固件 2.1.0（型号 X1）');
const fw = s.createFirmware({ version: '2.1.0', model: 'X1', note: '灰度版本' });
s.publishFirmware(fw.id);
log('固件', s.listFirmwares().map((f) => `${f.version}(${f.status})`).join(' '));

title('批次1：圈选设备下发，站点容量上限导致排队');
const camp = s.createCampaign({
  firmware_id: fw.id,
  name: 'X1 升级 2.1.0',
  device_ids: [devs[0].id, devs[1].id, devs[2].id, devs[5].id, devs[6].id], // D01 D02 D03 | D06 D07
});
const b1 = camp.batches[0];
log('批次1 任务', '');
taskTable(s.getBatch(b1.id).tasks);
const d1 = s.dispatchBatch(b1.id);
log('派发结果', `已下发 ${d1.dispatched}，排队 ${d1.queued}`);
log('站点容量占用', s.listStations().map((x) => `${x.name}: 在途${x.in_flight}/容量${x.capacity} 排队${x.queued}`).join('  '));
console.log('  >> A站容量2：D01/D02 下发，D03 排队等下一批；B站容量2：D06/D07 下发');

title('回执：升级成功 / 失败，重复回执幂等');
const byTag = Object.fromEntries(s.listDevices().map((d) => [d.asset_tag, d]));
function cmdOf(assetTag) {
  const dev = byTag[assetTag];
  const t = s.db.prepare('SELECT * FROM upgrade_tasks WHERE device_id=? ORDER BY id DESC LIMIT 1').get(dev.id);
  return s.db.prepare('SELECT * FROM commands WHERE id=?').get(t.command_id);
}
const rD01 = s.ackCommand(cmdOf('D01').id, { success: true });
const rD02 = s.ackCommand(cmdOf('D02').id, { success: true });
const rD06 = s.ackCommand(cmdOf('D06').id, { success: true });
const rD07 = s.ackCommand(cmdOf('D07').id, { success: false });
log('D01 回执', rD01.task.status);
log('D02 回执', rD02.task.status);
log('D06 回执', rD06.task.status);
log('D07 回执', rD07.task.status, '(升级失败)');
const rD01Again = s.ackCommand(cmdOf('D01').id, { success: true });
log('D01 重复回执', `幂等=${rD01Again.idempotent}（只算一次，不重复升级）`);

title('批次2：排队任务结转 + 新圈设备，再按容量下发');
const nb2 = s.createNextBatch(camp.id, [devs[3].id, devs[4].id, devs[7].id, devs[8].id]); // D04 D05 | D08 D09
log('批次2 任务（D03 从批次1结转）', '');
taskTable(s.getBatch(nb2.batch.id).tasks);
const d2 = s.dispatchBatch(nb2.batch.id);
log('派发结果', `已下发 ${d2.dispatched}，排队 ${d2.queued}`);
const rD03 = s.ackCommand(cmdOf('D03').id, { success: true });
const rD04 = s.ackCommand(cmdOf('D04').id, { success: true });
const rD08 = s.ackCommand(cmdOf('D08').id, { success: true });
const rD09 = s.ackCommand(cmdOf('D09').id, { success: true });
log('回执', `D03=${rD03.task.status} D04=${rD04.task.status} D08=${rD08.task.status} D09=${rD09.task.status}`);
console.log('  >> D05 仍排队，结转到批次3');

title('发布批次1（已发布批次作废时豁免）');
s.publishBatch(b1.id);
log('批次1', `published=${s.getBatch(b1.id).published} status=${s.getBatch(b1.id).status}`);
console.log('  >> 批次1 已发布，固件作废时其中设备保持原样、不回退');

title('断网恢复：C站断网，恢复后按顺序补发');
s.updateStation(C.id, { online: false });
const nb3 = s.createNextBatch(camp.id, [devs[9].id, devs[10].id]); // D10 D11
log('批次3 任务（C站断网）', '');
taskTable(s.getBatch(nb3.batch.id).tasks);
const d3 = s.dispatchBatch(nb3.batch.id);
log('派发结果', `已下发 ${d3.dispatched}，排队 ${d3.queued}`);
log('C站', s.listStations().filter((x) => x.name === 'C站').map((x) => `在线=${x.online} 在途=${x.in_flight} 排队=${x.queued}`).join(' '));
console.log('  >> C站断网：D10/D11 指令 pending；D05(A站) 已下发在途');

const rec = s.recoverStation(C.id);
log('C站恢复', `补发未回执 ${rec.redelivered} 条，新下发 ${rec.delivered} 条，仍排队 ${rec.stillPending} 条`);
log('C站恢复后', s.listStations().filter((x) => x.name === 'C站').map((x) => `在线=${x.online} 在途=${x.in_flight} 排队=${x.queued}`).join(' '));
console.log('  >> 先补发已下发未回执指令（按 sequence_no 顺序），再发排队指令；C站容量1：D10 下发、D11 继续排队');

const rD10 = s.ackCommand(cmdOf('D10').id, { success: true });
log('D10 回执', rD10.task.status);

title('固件 2.1.0 出事作废');
const inv = s.invalidateFirmware(fw.id);
log('作废结果', `停住批次 ${inv.batchesStopped} 个，需回退设备 ${inv.devicesToRollback} 台`);
log('批次1（已发布）', s.getBatch(b1.id).status, '>> 保持原样，不回退');
log('批次2（未发布）', s.getBatch(nb2.batch.id).status, '>> 停住，已升级设备回退');
log('批次3（未发布）', s.getBatch(nb3.batch.id).status, '>> 停住');
log('各设备任务状态', '');
for (const tag of ['D01','D02','D03','D04','D05','D06','D07','D08','D09','D10','D11']) {
  const dev = byTag[tag];
  const t = s.db.prepare('SELECT status FROM upgrade_tasks WHERE device_id=? ORDER BY id DESC LIMIT 1').get(dev.id);
  console.log(`    ${tag}: ${t.status}`);
}

title('回退指令回执：D08 回退失败');
function rollbackOf(assetTag) {
  const dev = byTag[assetTag];
  const t = s.db.prepare('SELECT * FROM upgrade_tasks WHERE device_id=? ORDER BY id DESC LIMIT 1').get(dev.id);
  return s.db.prepare('SELECT * FROM commands WHERE id=?').get(t.rollback_command_id);
}
for (const tag of ['D03', 'D04', 'D08', 'D09', 'D10']) {
  const cmd = rollbackOf(tag);
  if (!cmd) { console.log(`    ${tag}: 无回退指令`); continue; }
  const ok = tag !== 'D08';
  const r = s.ackCommand(cmd.id, { success: ok });
  console.log(`    ${tag} 回退回执: ${r.task.status}${ok ? '' : '（失败，仍停留在 2.1.0）'}`);
}

title('发布修复版本 2.2.0，资产系统同步应有版本');
const fw2 = s.createFirmware({ version: '2.2.0', model: 'X1', note: '修复版本' });
s.publishFirmware(fw2.id);
s.syncAssetSystem(devs.map((d) => ({ asset_tag: d.asset_tag, expected_version: '2.2.0' })));
log('资产同步', '所有 X1 设备应有版本 = 2.2.0');

title('月底对账：漏升 / 错升 / 回退失败');
const rec2 = s.reconcile();
console.log(`\n  漏升设备（落后于资产要求 2.2.0，需升 2.2.0）: ${rec2.missed.length} 台`);
for (const d of rec2.missed) console.log(`    - ${d.asset_tag}  当前 ${d.current_version}  应有 ${d.expected_version}  (${d.reason})`);
console.log(`\n  错升设备（仍在作废版本 2.1.0 上；已发布批次按策略保留、但仍列出对账）: ${rec2.wrong.length} 台`);
for (const d of rec2.wrong) console.log(`    - ${d.asset_tag}  当前 ${d.current_version}  (${d.reason})`);
console.log(`\n  回退失败设备: ${rec2.rollback_failed.length} 台`);
for (const d of rec2.rollback_failed) console.log(`    - ${d.asset_tag}  当前 ${d.current_version}  应有 ${d.expected_version}`);
if (rec2.rollback_pending.length) {
  console.log(`\n  回退中（卡住）: ${rec2.rollback_pending.length} 台`);
  for (const d of rec2.rollback_pending) console.log(`    - ${d.asset_tag}  当前 ${d.current_version}`);
}

console.log(`\n${'='.repeat(70)}`);
console.log('演示完成。数据库文件:', DB_PATH);
console.log('可执行 npm start 启动 HTTP 服务，或 npm test 运行单元测试。');
console.log('='.repeat(70));

db.close();
