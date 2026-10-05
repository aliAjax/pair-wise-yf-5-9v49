'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { openDb } = require('../src/db');
const { createService } = require('../src/service');
const { createServer } = require('../src/server');

function start() {
  const db = openDb(':memory:');
  const service = createService(db);
  const app = createServer(service);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port, service }));
  });
}

function req(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { port, method, path, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('HTTP 接口：健康检查与完整升级流程', async (t) => {
  const { server, port } = await start();
  try {
    const health = await req(port, 'GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const st = await req(port, 'POST', '/api/stations', { name: 'A站', capacity: 2 });
    assert.equal(st.body.ok, true);
    const stationId = st.body.data.id;

    const dev = await req(port, 'POST', '/api/devices', {
      devices: [{ asset_tag: 'D01', station_id: stationId, model: 'X1', current_version: '2.0.0' }],
    });
    assert.equal(dev.body.ok, true);
    const deviceId = dev.body.data[0].id;

    const fw = await req(port, 'POST', '/api/firmwares', { version: '2.1.0', model: 'X1' });
    const firmwareId = fw.body.data.id;
    await req(port, 'POST', `/api/firmwares/${firmwareId}/publish`, {});

    const camp = await req(port, 'POST', '/api/campaigns', { firmware_id: firmwareId, device_ids: [deviceId] });
    assert.equal(camp.body.ok, true);
    const batchId = camp.body.data.batches[0].id;

    const disp = await req(port, 'POST', `/api/batches/${batchId}/dispatch`, {});
    assert.equal(disp.body.data.dispatched, 1);

    const cmds = await req(port, 'GET', '/api/commands?status=dispatched');
    const cmdId = cmds.body.data[0].id;
    const ack = await req(port, 'POST', `/api/commands/${cmdId}/ack`, { success: true });
    assert.equal(ack.body.data.task.status, 'upgraded');
    // 重复回执幂等
    const ack2 = await req(port, 'POST', `/api/commands/${cmdId}/ack`, { success: true });
    assert.equal(ack2.body.data.idempotent, true);

    await req(port, 'POST', `/api/firmwares/${firmwareId}/invalidate`, {});
    const rec = await req(port, 'POST', '/api/reconcile', {});
    assert.equal(rec.body.ok, true);
    assert.ok('missed' in rec.body.data);
    assert.ok('wrong' in rec.body.data);
    assert.ok('rollback_failed' in rec.body.data);
  } finally {
    server.close();
  }
});

test('HTTP 接口：参数错误返回 400', async () => {
  const { server, port } = await start();
  try {
    const r = await req(port, 'POST', '/api/campaigns', { firmware_id: 999, device_ids: [] });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
  } finally {
    server.close();
  }
});
