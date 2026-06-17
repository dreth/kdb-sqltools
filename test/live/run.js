const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const KdbDriver = require('../../out/ls/driver').default;
const { ContextValue } = require('@sqltools/types');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const FIXTURE = path.join(__dirname, 'fixture.q');

(async () => {
  const qPath = resolveQPath();
  if (!qPath) {
    const message = 'No q binary found. Set KDB_Q_BIN=/path/to/q to run live kdb+/q tests.';
    if (process.env.KDB_SQLTOOLS_LIVE_REQUIRED === '1') {
      throw new Error(message);
    }
    console.log(`Skipping live kdb+/q test: ${message}`);
    return;
  }

  const port = await getFreePort();
  const q = startQ(qPath, port);

  try {
    await waitForQ(port, 15000);
    await runLiveAssertions(port);
    console.log(`Live kdb+/q test passed using ${qPath}`);
  } finally {
    await stopQ(q);
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});

async function runLiveAssertions(port) {
  const driver = createDriver(port);

  try {
    await driver.testConnection();

    const trade = await driver.query('select sym,size,price from trade where sym in `AAPL`MSFT');
    assert.strictEqual(trade.length, 1);
    assert.strictEqual(trade[0].error, undefined);
    assert.deepStrictEqual(trade[0].cols, ['sym', 'size', 'price']);
    assert.deepStrictEqual(trade[0].results, [
      { sym: 'AAPL', size: 100, price: 123.45 },
      { sym: 'MSFT', size: 250, price: 234.56 },
    ]);

    const scalar = await driver.query('calcSpread[123.40;123.50]');
    assert.strictEqual(scalar[0].error, undefined);
    assert.deepStrictEqual(scalar[0].cols, ['value']);
    assert.strictEqual(Number(scalar[0].results[0].value.toFixed(2)), 0.10);

    const connectionItem = {
      label: 'live q',
      type: ContextValue.CONNECTION,
      database: '.',
      schema: '.',
    };
    const groups = await driver.getChildrenForItem({ item: connectionItem });
    const tablesGroup = groups.find(item => item.label === 'Tables');
    assert.ok(tablesGroup, 'expected Tables explorer group');

    const tables = await driver.getChildrenForItem({ item: tablesGroup, parent: connectionItem });
    const labels = tables.map(item => item.label).sort();
    assert.ok(labels.includes('trade'), `expected trade table in ${labels.join(', ')}`);
    assert.ok(labels.includes('quote'), `expected quote table in ${labels.join(', ')}`);

    const tradeItem = tables.find(item => item.label === 'trade');
    const columnGroups = await driver.getChildrenForItem({ item: tradeItem, parent: tablesGroup });
    const columns = await driver.getChildrenForItem({ item: columnGroups[0], parent: tradeItem });
    const columnTypes = Object.fromEntries(columns.map(column => [column.label, column.dataType]));
    assert.deepStrictEqual(
      { sym: columnTypes.sym, size: columnTypes.size, price: columnTypes.price, day: columnTypes.day, ts: columnTypes.ts },
      { sym: 'symbol', size: 'int', price: 'float', day: 'date', ts: 'timestamp' }
    );

    const preview = await driver.queries.fetchRecords({ namespace: '.', table: { label: 'trade' }, limit: 2, offset: 1 }).toString();
    const previewResult = await driver.query(preview);
    assert.strictEqual(previewResult[0].results.length, 2);
    assert.deepStrictEqual(previewResult[0].results.map(row => row.sym), ['MSFT', 'GOOG']);
  } finally {
    await driver.close();
  }
}

function createDriver(port) {
  return new KdbDriver({
    id: 'live-q',
    name: 'Live q',
    driver: 'KDB',
    server: '127.0.0.1',
    port,
    database: '.',
    username: '',
    password: '',
    connectionTimeout: 10,
    isConnected: false,
    isActive: false,
  }, async () => []);
}

function resolveQPath() {
  const candidates = [
    process.env.KDB_Q_BIN,
    path.join(process.env.HOME || '', '.kx', 'bin', 'q'),
    '/opt/data/home/.kx/bin/q',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const result = cp.spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? ['q'] : ['-v', 'q'], {
    encoding: 'utf8',
    shell: process.platform !== 'win32',
  });
  return result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean) : null;
}

function startQ(qPath, port) {
  const q = cp.spawn(qPath, [FIXTURE, '-p', String(port)], {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  q.stdout.setEncoding('utf8');
  q.stderr.setEncoding('utf8');
  q.stdout.on('data', chunk => process.env.KDB_SQLTOOLS_LIVE_VERBOSE === '1' && process.stdout.write(chunk));
  q.stderr.on('data', chunk => process.env.KDB_SQLTOOLS_LIVE_VERBOSE === '1' && process.stderr.write(chunk));

  return q;
}

async function stopQ(q) {
  if (!q || q.exitCode !== null || q.signalCode) {
    return;
  }

  q.stdin.write('\\\\\n');
  q.stdin.end();

  const exited = await Promise.race([
    new Promise(resolve => q.once('exit', () => resolve(true))),
    delay(2000).then(() => false),
  ]);

  if (!exited) {
    q.kill('SIGTERM');
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForQ(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canConnect(port)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for q on port ${port}`);
}

function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
