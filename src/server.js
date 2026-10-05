'use strict';

const express = require('express');

function createServer(service) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const wrap = (fn) => (req, res) => {
    try {
      const result = fn(req);
      res.json({ ok: true, data: result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  };

  app.get('/api/health', (req, res) => res.json({ ok: true, data: { status: 'up', time: new Date().toISOString() } }));

  // 站点
  app.post('/api/stations', wrap((req) => service.createStation(req.body)));
  app.get('/api/stations', wrap(() => service.listStations()));
  app.patch('/api/stations/:id', wrap((req) => service.updateStation(Number(req.params.id), req.body)));
  app.post('/api/stations/:id/recover', wrap((req) => service.recoverStation(Number(req.params.id))));

  // 设备
  app.post('/api/devices', wrap((req) => service.registerDevices(req.body.devices || [])));
  app.get('/api/devices', wrap((req) => service.listDevices(req.query)));

  // 资产系统对账同步（应有版本）
  app.post('/api/asset/sync', wrap((req) => service.syncAssetSystem(req.body.updates || [])));

  // 固件
  app.post('/api/firmwares', wrap((req) => service.createFirmware(req.body)));
  app.get('/api/firmwares', wrap((req) => service.listFirmwares(req.query)));
  app.post('/api/firmwares/:id/publish', wrap((req) => service.publishFirmware(Number(req.params.id))));
  app.post('/api/firmwares/:id/invalidate', wrap((req) => service.invalidateFirmware(Number(req.params.id))));

  // 升级活动
  app.post('/api/campaigns', wrap((req) => service.createCampaign(req.body)));
  app.get('/api/campaigns', wrap(() => service.listCampaigns()));
  app.get('/api/campaigns/:id', wrap((req) => service.getCampaign(Number(req.params.id))));
  app.post('/api/campaigns/:id/batches', wrap((req) => service.createNextBatch(Number(req.params.id), req.body.device_ids || [])));

  // 批次
  app.post('/api/batches/:id/dispatch', wrap((req) => service.dispatchBatch(Number(req.params.id))));
  app.post('/api/batches/:id/publish', wrap((req) => service.publishBatch(Number(req.params.id))));
  app.get('/api/batches/:id', wrap((req) => service.getBatch(Number(req.params.id))));

  // 指令回执（幂等）
  app.post('/api/commands/:id/ack', wrap((req) => service.ackCommand(Number(req.params.id), req.body)));
  app.get('/api/commands', wrap((req) => service.listCommands(req.query)));

  // 月底对账
  app.post('/api/reconcile', wrap(() => service.reconcile()));
  app.get('/api/reconcile', wrap(() => service.listReconciliations()));

  app.use((req, res) => res.status(404).json({ ok: false, error: 'not found' }));
  return app;
}

module.exports = { createServer };
