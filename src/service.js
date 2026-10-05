'use strict';

/**
 * 灰度升级服务领域层。
 *
 * 关键不变量：
 *  - 每个站点同一时刻在途（dispatched 未回执）升级任务数不超过站点容量 capacity；
 *    超出的任务排队（queued），随下一批次或再次派发时按顺序下发。
 *  - 断网恢复后，先把“已下发未回执”的指令按 sequence_no 顺序补发，再发排队中的新指令。
 *  - 指令回执幂等：同一指令（commandId）重复送达只生效一次。
 *  - 固件作废：未发布批次立即停住，已升级设备回退到 from_version；已发布批次保持原样。
 *  - 月底对账：漏升（落后于资产系统应有版本）、错升（在作废版本上 / 超前）、回退失败三类。
 */

function parseVersion(v) {
  return String(v == null ? '' : v).split('.').map((n) => parseInt(n, 10) || 0);
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function createService(db) {
  // ---------- 内部工具 ----------
  const nextTaskSeq = (stationId) =>
    db.prepare('SELECT COALESCE(MAX(sequence_no),0)+1 AS s FROM upgrade_tasks WHERE station_id=?').get(stationId).s;
  const nextCommandSeq = (stationId) =>
    db.prepare('SELECT COALESCE(MAX(sequence_no),0)+1 AS s FROM commands WHERE station_id=?').get(stationId).s;

  const countInFlight = (stationId) =>
    db.prepare("SELECT COUNT(*) AS c FROM upgrade_tasks WHERE station_id=? AND status='dispatched'").get(stationId).c;

  function getStation(id) {
    return db.prepare('SELECT * FROM stations WHERE id=?').get(id);
  }
  function getFirmware(id) {
    return db.prepare('SELECT * FROM firmwares WHERE id=?').get(id);
  }
  function getTask(id) {
    return db.prepare('SELECT * FROM upgrade_tasks WHERE id=?').get(id);
  }

  function ensureUpgradeCommand(task) {
    if (task.command_id) {
      const existing = db.prepare('SELECT * FROM commands WHERE id=?').get(task.command_id);
      if (existing) return existing;
    }
    const seq = nextCommandSeq(task.station_id);
    const key = `cmd:${task.id}:upgrade`;
    const payload = JSON.stringify({ kind: 'upgrade', to: task.to_version, from: task.from_version });
    const info = db
      .prepare(
        `INSERT INTO commands (task_id, station_id, device_id, type, payload, sequence_no, idempotency_key, status)
         VALUES (?,?,?, 'upgrade', ?, ?, ?, 'pending')`
      )
      .run(task.id, task.station_id, task.device_id, payload, seq, key);
    db.prepare('UPDATE upgrade_tasks SET command_id=? WHERE id=?').run(info.lastInsertRowid, task.id);
    task.command_id = info.lastInsertRowid;
    return db.prepare('SELECT * FROM commands WHERE id=?').get(info.lastInsertRowid);
  }

  function issueRollbackCommand(task) {
    if (task.rollback_command_id) {
      const existing = db.prepare('SELECT * FROM commands WHERE id=?').get(task.rollback_command_id);
      if (existing) return existing;
    }
    const seq = nextCommandSeq(task.station_id);
    const key = `cmd:${task.id}:rollback`;
    const payload = JSON.stringify({ kind: 'rollback', to: task.from_version, from: task.to_version });
    const info = db
      .prepare(
        `INSERT INTO commands (task_id, station_id, device_id, type, payload, sequence_no, idempotency_key, status)
         VALUES (?,?,?, 'rollback', ?, ?, ?, 'pending')`
      )
      .run(task.id, task.station_id, task.device_id, payload, seq, key);
    db
      .prepare(
        "UPDATE upgrade_tasks SET rollback_command_id=?, status='rolling_back' WHERE id=?"
      )
      .run(info.lastInsertRowid, task.id);
    task.rollback_command_id = info.lastInsertRowid;
    task.status = 'rolling_back';
    let command = db.prepare('SELECT * FROM commands WHERE id=?').get(info.lastInsertRowid);
    // 回退是纠正性操作：站点在线即下发，断网则挂起待恢复后补发
    const station = getStation(task.station_id);
    if (station.online) {
      db.prepare("UPDATE commands SET status='dispatched', dispatched_at=? WHERE id=?").run(now(), command.id);
      command = db.prepare('SELECT * FROM commands WHERE id=?').get(command.id);
    }
    return command;
  }

  function refreshBatchStatus(batchId) {
    const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(batchId);
    if (!batch) return;
    if (batch.status === 'paused') return; // 作废停住的批次不再自动迁移
    const agg = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('queued','dispatched','rolling_back') THEN 1 ELSE 0 END) AS open,
           COUNT(*) AS total
         FROM upgrade_tasks WHERE batch_id=?`
      )
      .get(batchId);
    let status;
    if (batch.published) status = 'published';
    else if (agg.open > 0) status = agg.open === agg.total ? 'pending' : 'running';
    else status = 'completed';
    if (status !== batch.status) {
      db.prepare('UPDATE batches SET status=? WHERE id=?').run(status, batchId);
    }
  }

  function refreshCampaignStatus(campaignId) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
    if (!campaign || campaign.status === 'invalidated') return;
    const agg = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS open,
           COUNT(*) AS total
         FROM batches WHERE campaign_id=?`
      )
      .get(campaignId);
    const status = agg.total > 0 && agg.open === 0 ? 'completed' : 'active';
    if (status !== campaign.status) {
      db.prepare('UPDATE campaigns SET status=? WHERE id=?').run(status, campaignId);
    }
  }

  // 校验设备可纳入某固件的升级批次
  function validateDeviceForFirmware(device, firmware) {
    if (!device) return '设备不存在';
    if (device.status !== 'active') return '设备已报废';
    if (device.model !== firmware.model) return `设备型号 ${device.model} 与固件型号 ${firmware.model} 不匹配`;
    if (device.current_version === firmware.version) return '设备已在目标版本';
    const dup = db
      .prepare(
        `SELECT t.id FROM upgrade_tasks t
         JOIN batches b ON b.id = t.batch_id
         WHERE t.device_id=? AND t.firmware_id=? AND t.status IN ('queued','dispatched','upgraded','rolling_back')
         LIMIT 1`
      )
      .get(device.id, firmware.id);
    if (dup) return '设备已在该固件的升级批次中';
    return null;
  }

  // ---------- 站点 ----------
  function createStation({ name, model = null, capacity = 1, online = true }) {
    const info = db
      .prepare('INSERT INTO stations (name, model, capacity, online) VALUES (?,?,?,?)')
      .run(name, model, capacity, online ? 1 : 0);
    return getStation(info.lastInsertRowid);
  }

  function listStations() {
    return db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM upgrade_tasks t WHERE t.station_id=s.id AND t.status='dispatched') AS in_flight,
                (SELECT COUNT(*) FROM upgrade_tasks t WHERE t.station_id=s.id AND t.status='queued') AS queued
         FROM stations s ORDER BY s.id`
      )
      .all();
  }

  function updateStation(id, { capacity, online, model, name }) {
    const s = getStation(id);
    if (!s) throw new Error('站点不存在');
    db.prepare(
      `UPDATE stations SET
         capacity=COALESCE(?,capacity), online=COALESCE(?,online),
         model=COALESCE(?,model), name=COALESCE(?,name)
       WHERE id=?`
    ).run(capacity ?? null, online == null ? null : online ? 1 : 0, model ?? null, name ?? null, id);
    return getStation(id);
  }

  // 断网恢复：先补发已下发未回执指令（按顺序），再发排队中的新指令
  function recoverStation(stationId) {
    const station = getStation(stationId);
    if (!station) throw new Error('站点不存在');
    const tx = db.transaction(() => {
      db.prepare("UPDATE stations SET online=1 WHERE id=?").run(stationId);

      // 1) 已下发未回执：按 sequence_no 顺序补发（重试），不占用新容量
      const unacked = db
        .prepare(
          `SELECT * FROM commands WHERE station_id=? AND status='dispatched' ORDER BY sequence_no`
        )
        .all(stationId);
      const redelivered = unacked.length;
      const updCmd = db.prepare(
        "UPDATE commands SET dispatched_at=?, retry_count=retry_count+1 WHERE id=?"
      );
      for (const c of unacked) updCmd.run(now(), c.id);

      // 2) 排队中的指令：回退指令纠正性优先全部下发；升级指令在容量范围内按顺序下发
      const pending = db
        .prepare(
          `SELECT c.* FROM commands c
           JOIN upgrade_tasks t ON t.id = c.task_id
           WHERE c.station_id=? AND c.status='pending'
           ORDER BY c.sequence_no`
        )
        .all(stationId);
      let inFlight = countInFlight(stationId);
      const capacity = station.capacity;
      let delivered = 0;
      const markCmd = db.prepare(
        "UPDATE commands SET status='dispatched', dispatched_at=? WHERE id=?"
      );
      const markTask = db.prepare(
        "UPDATE upgrade_tasks SET status='dispatched', dispatched_at=? WHERE id=?"
      );
      for (const c of pending) {
        if (c.type === 'rollback') {
          markCmd.run(now(), c.id); // 回退指令不受升级容量限制
          delivered++;
          continue;
        }
        if (inFlight >= capacity) break;
        markCmd.run(now(), c.id);
        markTask.run(now(), c.task_id);
        inFlight++;
        delivered++;
      }
      return { redelivered, delivered, stillPending: pending.length - delivered };
    });
    const r = tx();
    return { station: getStation(stationId), ...r };
  }

  // ---------- 设备 ----------
  function registerDevices(devices) {
    const tx = db.transaction((list) => {
      const out = [];
      for (const d of list) {
        let stationId = d.station_id;
        if (d.station_name && !stationId) {
          const st = db.prepare('SELECT id FROM stations WHERE name=?').get(d.station_name);
          if (!st) throw new Error(`站点不存在: ${d.station_name}`);
          stationId = st.id;
        }
        if (!stationId) throw new Error(`设备 ${d.asset_tag} 缺少 station_id/station_name`);
        const existing = db.prepare('SELECT * FROM devices WHERE asset_tag=?').get(d.asset_tag);
        if (existing) {
          db.prepare(
            `UPDATE devices SET station_id=?, model=COALESCE(?,model),
               current_version=COALESCE(?,current_version), status=COALESCE(?,status)
             WHERE id=?`
          ).run(stationId, d.model ?? null, d.current_version ?? null, d.status ?? null, existing.id);
          out.push(db.prepare('SELECT * FROM devices WHERE id=?').get(existing.id));
        } else {
          const info = db
            .prepare(
              `INSERT INTO devices (asset_tag, station_id, model, current_version, status)
               VALUES (?,?,?,?, COALESCE(?, 'active'))`
            )
            .run(d.asset_tag, stationId, d.model, d.current_version ?? null, d.status ?? null);
          out.push(db.prepare('SELECT * FROM devices WHERE id=?').get(info.lastInsertRowid));
        }
      }
      return out;
    });
    return tx(devices);
  }

  function listDevices({ station_id, model, status } = {}) {
    const conds = [];
    const args = [];
    if (station_id) { conds.push('station_id=?'); args.push(station_id); }
    if (model) { conds.push('model=?'); args.push(model); }
    if (status) { conds.push('status=?'); args.push(status); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM devices ${where} ORDER BY id`).all(...args);
  }

  // 资产系统对账：同步每台设备的“应有版本”
  function syncAssetSystem(updates) {
    const tx = db.transaction((list) => {
      let n = 0;
      for (const u of list) {
        const dev = u.asset_tag
          ? db.prepare('SELECT * FROM devices WHERE asset_tag=?').get(u.asset_tag)
          : db.prepare('SELECT * FROM devices WHERE id=?').get(u.device_id);
        if (!dev) throw new Error(`资产系统中的设备未登记: ${u.asset_tag || u.device_id}`);
        db.prepare('UPDATE devices SET expected_version=? WHERE id=?').run(u.expected_version, dev.id);
        n++;
      }
      return n;
    });
    return tx(updates);
  }

  // ---------- 固件 ----------
  function createFirmware({ version, model, note = null }) {
    const info = db
      .prepare('INSERT INTO firmwares (version, model, note, status) VALUES (?,?,?,?)')
      .run(version, model, note, 'draft');
    return getFirmware(info.lastInsertRowid);
  }

  function publishFirmware(id) {
    const f = getFirmware(id);
    if (!f) throw new Error('固件不存在');
    if (f.status === 'invalid') throw new Error('已作废固件不能发布');
    if (f.status === 'published') return f;
    db.prepare("UPDATE firmwares SET status='published', published_at=? WHERE id=?").run(now(), id);
    return getFirmware(id);
  }

  function invalidateFirmware(id) {
    const f = getFirmware(id);
    if (!f) throw new Error('固件不存在');
    if (f.status === 'invalid') throw new Error('固件已作废');
    const tx = db.transaction(() => {
      db.prepare("UPDATE firmwares SET status='invalid', invalidated_at=? WHERE id=?").run(now(), id);

      const campaigns = db
        .prepare("SELECT * FROM campaigns WHERE firmware_id=? AND status IN ('active','completed')")
        .all(id);
      let batchesStopped = 0;
      let devicesToRollback = 0;
      const stopped = [];
      for (const c of campaigns) {
        db.prepare("UPDATE campaigns SET status='invalidated' WHERE id=?").run(c.id);
        const batches = db.prepare('SELECT * FROM batches WHERE campaign_id=? ORDER BY batch_no').all(c.id);
        for (const b of batches) {
          if (b.published) continue; // 已发布批次保持原样
          // 停住未跑完的批次
          db.prepare("UPDATE batches SET status='paused' WHERE id=?").run(b.id);
          batchesStopped++;
          // 已升级设备回退；在途（dispatched）任务中止，不再升级
          const tasks = db.prepare('SELECT * FROM upgrade_tasks WHERE batch_id=?').all(b.id);
          for (const t of tasks) {
            if (t.status === 'upgraded') {
              issueRollbackCommand(t);
              devicesToRollback++;
            } else if (t.status === 'dispatched') {
              db.prepare("UPDATE upgrade_tasks SET status='failed' WHERE id=?").run(t.id);
              const cmd = db.prepare('SELECT * FROM commands WHERE id=?').get(t.command_id);
              if (cmd && cmd.status === 'dispatched') {
                db.prepare("UPDATE commands SET status='acked', ack_result='failure', acked_at=? WHERE id=?").run(
                  now(),
                  cmd.id
                );
              }
            }
          }
          stopped.push({ batch_id: b.id, batch_no: b.batch_no });
        }
      }
      return { batchesStopped, devicesToRollback, stopped };
    });
    const r = tx();
    return { firmware: getFirmware(id), ...r };
  }

  function listFirmwares({ status, model } = {}) {
    const conds = [];
    const args = [];
    if (status) { conds.push('status=?'); args.push(status); }
    if (model) { conds.push('model=?'); args.push(model); }
    return db
      .prepare(`SELECT * FROM firmwares ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY id`)
      .all(...args);
  }

  // ---------- 升级活动 / 批次 ----------
  function createCampaign({ firmware_id, device_ids, name = null }) {
    const firmware = getFirmware(firmware_id);
    if (!firmware) throw new Error('固件不存在');
    if (firmware.status !== 'published') throw new Error('只有已发布的固件才能发起升级');
    const tx = db.transaction(() => {
      const info = db
        .prepare('INSERT INTO campaigns (firmware_id, name, status) VALUES (?,?,?)')
        .run(firmware_id, name, 'active');
      const campaignId = info.lastInsertRowid;
      const batchId = createBatchRow(campaignId, 1);
      const added = addDevicesToBatch(batchId, campaignId, firmware, device_ids);
      refreshBatchStatus(batchId);
      return { campaignId, batchId, added };
    });
    const r = tx();
    return getCampaign(r.campaignId);
  }

  function createBatchRow(campaignId, batchNo) {
    const info = db
      .prepare('INSERT INTO batches (campaign_id, batch_no, status) VALUES (?,?,?)')
      .run(campaignId, batchNo, 'pending');
    return info.lastInsertRowid;
  }

  function addDevicesToBatch(batchId, campaignId, firmware, deviceIds) {
    const added = [];
    const skipped = [];
    for (const deviceId of deviceIds) {
      const device = db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId);
      const err = validateDeviceForFirmware(device, firmware);
      if (err) { skipped.push({ device_id: deviceId, reason: err }); continue; }
      const station = getStation(device.station_id);
      const seq = nextTaskSeq(station.id);
      const info = db
        .prepare(
          `INSERT INTO upgrade_tasks
             (batch_id, campaign_id, device_id, station_id, firmware_id, from_version, to_version, status, sequence_no)
           VALUES (?,?,?,?,?,?,?, 'queued', ?)`
        )
        .run(batchId, campaignId, device.id, station.id, firmware.id,
             device.current_version, firmware.version, seq);
      added.push(db.prepare('SELECT * FROM upgrade_tasks WHERE id=?').get(info.lastInsertRowid));
    }
    return { added, skipped };
  }

  // 下一批：把本活动中排队的任务自动结转到新批次，再加入新圈选设备
  function createNextBatch(campaignId, deviceIds = []) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
    if (!campaign) throw new Error('升级活动不存在');
    if (campaign.status !== 'active') throw new Error('升级活动已停止');
    const firmware = getFirmware(campaign.firmware_id);
    if (firmware.status !== 'published') throw new Error('固件已作废，不能再建批次');
    const tx = db.transaction(() => {
      const maxNo = db
        .prepare('SELECT COALESCE(MAX(batch_no),0)+1 AS n FROM batches WHERE campaign_id=?')
        .get(campaignId).n;
      const batchId = createBatchRow(campaignId, maxNo);
      // 结转排队任务到新批次
      const carried = db
        .prepare("UPDATE upgrade_tasks SET batch_id=? WHERE campaign_id=? AND status='queued'")
        .run(batchId, campaignId).changes;
      const { added, skipped } = addDevicesToBatch(batchId, campaignId, firmware, deviceIds);
      refreshBatchStatus(batchId);
      // 结转后刷新本活动所有批次状态（旧批次可能已全部完成）
      for (const b of db.prepare('SELECT id FROM batches WHERE campaign_id=?').all(campaignId)) {
        refreshBatchStatus(b.id);
      }
      return { batchId, carried, added, skipped };
    });
    const r = tx();
    return { batch: getBatch(r.batchId), carried: r.carried, added: r.added, skipped: r.skipped };
  }

  function dispatchBatch(batchId) {
    const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(batchId);
    if (!batch) throw new Error('批次不存在');
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(batch.campaign_id);
    const firmware = getFirmware(campaign.firmware_id);
    if (firmware.status === 'invalid' || campaign.status === 'invalidated') {
      throw new Error('固件已作废，升级活动已停止');
    }
    if (batch.status === 'paused') throw new Error('批次已停住');
    const tx = db.transaction(() => {
      const tasks = db
        .prepare("SELECT * FROM upgrade_tasks WHERE batch_id=? AND status='queued' ORDER BY sequence_no")
        .all(batchId);
      // 确保每个排队任务都有升级指令
      for (const t of tasks) ensureUpgradeCommand(t);

      // 按站点、按顺序下发，受站点容量限制
      const byStation = new Map();
      for (const t of tasks) {
        if (!byStation.has(t.station_id)) byStation.set(t.station_id, []);
        byStation.get(t.station_id).push(t);
      }
      let dispatched = 0;
      let queued = 0;
      const markCmd = db.prepare("UPDATE commands SET status='dispatched', dispatched_at=? WHERE id=?");
      const markTask = db.prepare("UPDATE upgrade_tasks SET status='dispatched', dispatched_at=? WHERE id=?");
      for (const [stationId, list] of byStation) {
        const station = getStation(stationId);
        let inFlight = countInFlight(stationId);
        for (const t of list) {
          const cmd = db.prepare('SELECT * FROM commands WHERE id=?').get(t.command_id);
          if (station.online && inFlight < station.capacity) {
            markCmd.run(now(), cmd.id);
            markTask.run(now(), t.id);
            inFlight++;
            dispatched++;
          } else {
            queued++; // 容量超限或站点断网：排队等下一批 / 恢复后补发
          }
        }
      }
      refreshBatchStatus(batchId);
      refreshCampaignStatus(campaign.id);
      return { dispatched, queued };
    });
    const r = tx();
    return { batch: getBatch(batchId), ...r };
  }

  function publishBatch(batchId) {
    const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(batchId);
    if (!batch) throw new Error('批次不存在');
    if (batch.published) return batch;
    const open = db
      .prepare("SELECT COUNT(*) AS c FROM upgrade_tasks WHERE batch_id=? AND status IN ('queued','dispatched','rolling_back')")
      .get(batchId).c;
    if (open > 0) throw new Error('批次还有未完成任务，不能发布');
    db.prepare("UPDATE batches SET published=1, status='published' WHERE id=?").run(batchId);
    refreshCampaignStatus(batch.campaign_id);
    return getBatch(batchId);
  }

  function getBatch(batchId) {
    const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(batchId);
    if (!batch) return null;
    batch.tasks = db
      .prepare(
        `SELECT t.*, d.asset_tag, d.model, s.name AS station_name
         FROM upgrade_tasks t
         JOIN devices d ON d.id=t.device_id
         JOIN stations s ON s.id=t.station_id
         WHERE t.batch_id=? ORDER BY t.sequence_no`
      )
      .all(batchId);
    return batch;
  }

  function listBatches(campaignId) {
    return db
      .prepare('SELECT * FROM batches WHERE campaign_id=? ORDER BY batch_no')
      .all(campaignId)
      .map((b) => ({
        ...b,
        task_count: db.prepare('SELECT COUNT(*) AS c FROM upgrade_tasks WHERE batch_id=?').get(b.id).c,
        upgraded: db.prepare("SELECT COUNT(*) AS c FROM upgrade_tasks WHERE batch_id=? AND status='upgraded'").get(b.id).c,
      }));
  }

  function getCampaign(campaignId) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
    if (!campaign) return null;
    campaign.firmware = getFirmware(campaign.firmware_id);
    campaign.batches = listBatches(campaignId);
    return campaign;
  }

  function listCampaigns() {
    const rows = db
      .prepare(
        `SELECT c.*, f.version AS firmware_version, f.model AS firmware_model, f.status AS firmware_status
         FROM campaigns c JOIN firmwares f ON f.id=c.firmware_id
         ORDER BY c.id DESC`
      )
      .all();
    return rows;
  }

  // ---------- 指令回执（幂等） ----------
  function ackCommand(commandId, { success = true, note = null } = {}) {
    const command = db.prepare('SELECT * FROM commands WHERE id=?').get(commandId);
    if (!command) throw new Error('指令不存在');
    const task = getTask(command.task_id);
    const firmware = getFirmware(task.firmware_id);
    const tx = db.transaction(() => {
      // 幂等：同一指令重复回执只算一次
      if (command.status === 'acked') {
        return { idempotent: true, command: db.prepare('SELECT * FROM commands WHERE id=?').get(commandId), task: getTask(command.task_id) };
      }
      if (command.status !== 'dispatched') {
        throw new Error('指令未下发（pending），不能回执');
      }
      db.prepare("UPDATE commands SET status='acked', ack_result=?, acked_at=? WHERE id=?").run(
        success ? 'success' : 'failure',
        now(),
        commandId
      );
      let newStatus;
      if (command.type === 'rollback') {
        newStatus = success ? 'rolled_back' : 'rollback_failed';
        db.prepare('UPDATE upgrade_tasks SET status=?, rolled_back_at=? WHERE id=?').run(
          newStatus,
          success ? now() : null,
          task.id
        );
        if (success) {
          db.prepare('UPDATE devices SET current_version=? WHERE id=?').run(task.from_version, task.device_id);
        }
      } else {
        // upgrade
        if (firmware.status === 'invalid') {
          newStatus = 'failed'; // 固件作废后的迟到回执：中止，不升级
          db.prepare("UPDATE upgrade_tasks SET status='failed' WHERE id=?").run(task.id);
        } else {
          newStatus = success ? 'upgraded' : 'failed';
          db.prepare('UPDATE upgrade_tasks SET status=?, upgraded_at=? WHERE id=?').run(
            newStatus,
            success ? now() : null,
            task.id
          );
          if (success) {
            db.prepare('UPDATE devices SET current_version=? WHERE id=?').run(task.to_version, task.device_id);
          }
        }
      }
      refreshBatchStatus(task.batch_id);
      refreshCampaignStatus(task.campaign_id);
      return { idempotent: false, command: db.prepare('SELECT * FROM commands WHERE id=?').get(commandId), task: getTask(task.id) };
    });
    return tx();
  }

  function listCommands({ station_id, status, type } = {}) {
    const conds = [];
    const args = [];
    if (station_id) { conds.push('c.station_id=?'); args.push(station_id); }
    if (status) { conds.push('c.status=?'); args.push(status); }
    if (type) { conds.push('c.type=?'); args.push(type); }
    return db
      .prepare(
        `SELECT c.*, t.batch_id, d.asset_tag
         FROM commands c
         JOIN upgrade_tasks t ON t.id=c.task_id
         JOIN devices d ON d.id=c.device_id
         ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
         ORDER BY c.station_id, c.sequence_no`
      )
      .all(...args);
  }

  // ---------- 月底对账 ----------
  function reconcile() {
    const devices = db
      .prepare("SELECT * FROM devices WHERE status='active' ORDER BY id")
      .all();
    const missed = [];
    const wrong = [];
    const rollbackFailed = [];
    const rollbackPending = [];
    for (const d of devices) {
      const current = d.current_version;
      const expected = d.expected_version;
      const invalid = db
        .prepare("SELECT id FROM firmwares WHERE version=? AND model=? AND status='invalid' LIMIT 1")
        .get(current, d.model);
      const rbFail = db
        .prepare("SELECT id FROM upgrade_tasks WHERE device_id=? AND status='rollback_failed' LIMIT 1")
        .get(d.id);
      const rbPending = db
        .prepare("SELECT id FROM upgrade_tasks WHERE device_id=? AND status='rolling_back' LIMIT 1")
        .get(d.id);

      const entry = {
        device_id: d.id,
        asset_tag: d.asset_tag,
        station_id: d.station_id,
        model: d.model,
        current_version: current,
        expected_version: expected,
      };
      if (rbFail) {
        rollbackFailed.push(entry);
      } else if (rbPending) {
        rollbackPending.push(entry);
      } else if (invalid) {
        wrong.push({ ...entry, reason: '设备仍在作废固件版本上，未回退' });
      } else if (expected && compareVersions(current, expected) < 0) {
        missed.push({ ...entry, reason: `落后于资产系统要求版本 ${expected}` });
      } else if (expected && compareVersions(current, expected) > 0) {
        wrong.push({ ...entry, reason: `版本高于资产系统要求版本 ${expected}` });
      }
    }
    const detail = { missed, wrong, rollback_failed: rollbackFailed, rollback_pending: rollbackPending };
    const info = db
      .prepare(
        `INSERT INTO reconciliations (missed_count, wrong_count, rollback_failed_count, detail)
         VALUES (?,?,?,?)`
      )
      .run(missed.length, wrong.length, rollbackFailed.length, JSON.stringify(detail));
    return {
      id: info.lastInsertRowid,
      run_at: now(),
      missed,
      wrong,
      rollback_failed: rollbackFailed,
      rollback_pending: rollbackPending,
      counts: {
        missed: missed.length,
        wrong: wrong.length,
        rollback_failed: rollbackFailed.length,
        rollback_pending: rollbackPending.length,
      },
    };
  }

  function listReconciliations() {
    return db
      .prepare('SELECT id, run_at, missed_count, wrong_count, rollback_failed_count FROM reconciliations ORDER BY id DESC')
      .all();
  }

  return {
    db,
    compareVersions,
    // stations
    createStation, listStations, updateStation, recoverStation,
    // devices
    registerDevices, listDevices, syncAssetSystem,
    // firmwares
    createFirmware, publishFirmware, invalidateFirmware, listFirmwares,
    // campaigns / batches
    createCampaign, createNextBatch, dispatchBatch, publishBatch,
    getBatch, listBatches, getCampaign, listCampaigns,
    // commands
    ackCommand, listCommands,
    // reconcile
    reconcile, listReconciliations,
  };
}

module.exports = { createService, compareVersions };
