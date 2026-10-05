'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  model      TEXT,
  capacity   INTEGER NOT NULL DEFAULT 1,              -- 站点并发上限
  online     INTEGER NOT NULL DEFAULT 1,              -- 1 在线 / 0 断网
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS devices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_tag       TEXT NOT NULL UNIQUE,               -- 资产编号
  station_id      INTEGER NOT NULL REFERENCES stations(id),
  model           TEXT NOT NULL,
  current_version TEXT,                               -- 当前固件版本
  expected_version TEXT,                              -- 资产系统对账的应有版本
  status          TEXT NOT NULL DEFAULT 'active',     -- active / scrapped
  registered_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_devices_station ON devices(station_id);
CREATE INDEX IF NOT EXISTS idx_devices_model ON devices(model);

CREATE TABLE IF NOT EXISTS firmwares (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version        TEXT NOT NULL,
  model          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft',       -- draft / published / invalid
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  published_at   TEXT,
  invalidated_at TEXT,
  UNIQUE(version, model)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  firmware_id INTEGER NOT NULL REFERENCES firmwares(id),
  name        TEXT,
  status      TEXT NOT NULL DEFAULT 'active',         -- active / invalidated / completed
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS batches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  batch_no   INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',         -- pending/running/completed/published/paused/rolled_back
  published  INTEGER NOT NULL DEFAULT 0,               -- 已发布批次作废时豁免
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(campaign_id, batch_no)
);

CREATE TABLE IF NOT EXISTS upgrade_tasks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id           INTEGER NOT NULL REFERENCES batches(id),
  campaign_id        INTEGER NOT NULL REFERENCES campaigns(id),
  device_id          INTEGER NOT NULL REFERENCES devices(id),
  station_id         INTEGER NOT NULL REFERENCES stations(id),
  firmware_id        INTEGER NOT NULL REFERENCES firmwares(id),
  from_version       TEXT,
  to_version         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'queued',  -- queued/dispatched/upgraded/failed/rolling_back/rolled_back/rollback_failed
  sequence_no        INTEGER NOT NULL,                -- 站点内排序
  command_id         INTEGER,                         -- 升级指令
  rollback_command_id INTEGER,                        -- 回退指令
  dispatched_at      TEXT,
  upgraded_at        TEXT,
  rolled_back_at     TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(batch_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_station_status ON upgrade_tasks(station_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_device ON upgrade_tasks(device_id);
CREATE INDEX IF NOT EXISTS idx_tasks_campaign ON upgrade_tasks(campaign_id);

CREATE TABLE IF NOT EXISTS commands (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         INTEGER NOT NULL REFERENCES upgrade_tasks(id),
  station_id      INTEGER NOT NULL REFERENCES stations(id),
  device_id       INTEGER NOT NULL REFERENCES devices(id),
  type            TEXT NOT NULL,                      -- upgrade / rollback
  payload         TEXT,
  sequence_no     INTEGER NOT NULL,                   -- 站点内单调递增，保证补发顺序
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending / dispatched / acked
  idempotency_key TEXT NOT NULL UNIQUE,               -- 同一指令重复回执只算一次
  retry_count     INTEGER NOT NULL DEFAULT 0,
  dispatched_at   TEXT,
  acked_at        TEXT,
  ack_result      TEXT,                               -- success / failure
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commands_station_status ON commands(station_id, status, sequence_no);

CREATE TABLE IF NOT EXISTS reconciliations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at               TEXT NOT NULL DEFAULT (datetime('now')),
  missed_count         INTEGER NOT NULL DEFAULT 0,
  wrong_count          INTEGER NOT NULL DEFAULT 0,
  rollback_failed_count INTEGER NOT NULL DEFAULT 0,
  detail               TEXT NOT NULL
);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb, SCHEMA };
