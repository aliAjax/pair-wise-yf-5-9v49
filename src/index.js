'use strict';

const path = require('path');
const { openDb } = require('./db');
const { createService } = require('./service');
const { createServer } = require('./server');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'upgrade.db');

const db = openDb(DB_PATH);
const service = createService(db);
const app = createServer(service);

app.listen(PORT, () => {
  console.log(`[grayscale-upgrade] listening on http://0.0.0.0:${PORT}`);
  console.log(`[grayscale-upgrade] db: ${DB_PATH}`);
});

module.exports = { app, service, db };
