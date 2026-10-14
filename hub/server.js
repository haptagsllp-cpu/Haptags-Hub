'use strict';

const config = require('./src/config');
const { migrate } = require('./src/db');
const { getSettings } = require('./src/lib/settings');
const { startScheduler } = require('./src/lib/automation');
const { ensureOwner } = require('./src/lib/bootstrap');

async function main() {
  await migrate();
  await getSettings();
  await ensureOwner();
  const app = require('./src/app');
  app.listen(config.port, () => {
    console.log(`Haptags Hub running on ${config.baseUrl} (port ${config.port}, db: ${config.db.client})`);
  });
  startScheduler();
}

main().catch((err) => {
  console.error('Failed to start Haptags Hub:', err);
  process.exit(1);
});
