const assert = require('assert');

const { deserializeQMessage, qValueToTabular, serializeTextQuery } = require('../out/ls/q-ipc');
const queriesModule = require('../out/ls/queries');
const KdbDriver = require('../out/ls/driver').default;
const { ContextValue } = require('@sqltools/types');
const connectionSchema = require('../connection.schema.json');

const queries = queriesModule.default;
const { normalizeNamespace, qString, qSymbolExpression } = queriesModule;

function hex(value) {
  return Buffer.from(value.replace(/\s/g, ''), 'hex');
}

(async () => {
  assert.strictEqual(
    serializeTextQuery('1+1').toString('hex'),
    '01010000110000000a0003000000312b31'
  );

  assert.strictEqual(
    deserializeQMessage(hex('010000000d000000fa01000000')),
    1
  );

  const table = deserializeQMessage(hex(
    '01000000620000006200630b0003000000610062006300000003000000070003000000010000000000000002000000000000000300000000000000010003000000010001090003000000000000000000f03f00000000000000400000000000000840'
  ));
  const tableResult = qValueToTabular(table);
  assert.deepStrictEqual(tableResult.cols, ['a', 'b', 'c']);
  assert.deepStrictEqual(tableResult.rows, [
    { a: 1, b: true, c: 1 },
    { a: 2, b: false, c: 2 },
    { a: 3, b: true, c: 3 },
  ]);

  const alreadyNormalizedRows = [{ a: 1 }, { a: 2 }];
  const efficientTableResult = qValueToTabular({
    qtype: 'table',
    columns: ['a'],
    rows: alreadyNormalizedRows,
    columnData: [[1, 2]],
  });
  assert.strictEqual(efficientTableResult.rows, alreadyNormalizedRows);

  const dict = deserializeQMessage(hex(
    '0100000033000000630b0003000000610062006300070003000000010000000000000002000000000000000300000000000000'
  ));
  assert.deepStrictEqual(qValueToTabular(dict).rows, [
    { key: 'a', value: 1 },
    { key: 'b', value: 2 },
    { key: 'c', value: 3 },
  ]);

  const charDict = deserializeQMessage(hex(
    '010000001f000000630b00030000006100620063000a000300000078797a'
  ));
  assert.deepStrictEqual(qValueToTabular(charDict).rows, [
    { key: 'a', value: 'x' },
    { key: 'b', value: 'y' },
    { key: 'c', value: 'z' },
  ]);

  assert.strictEqual(normalizeNamespace('analytics'), '.analytics');
  assert.strictEqual(normalizeNamespace('.analytics'), '.analytics');
  assert.strictEqual(qString('a"b\\c'), '"a\\"b\\\\c"');
  assert.strictEqual(qSymbolExpression('.analytics.trade'), '`$".analytics.trade"');

  const fetchRecords = queries.fetchRecords({
    namespace: '.analytics',
    table: { label: 'trade' },
    limit: 10,
    offset: 5,
  }).toString();
  assert.ok(fetchRecords.includes('}[".analytics";"trade";10;5]'));

  const driver = createDriver();

  const previewQueries = [];
  driver.query = async (query) => {
    const text = query.toString();
    previewQueries.push(text);
    if (text.includes('count value tbl')) {
      return [{
        cols: ['total'],
        messages: [],
        results: [{ total: 1000000 }],
      }];
    }
    return [{
      cols: ['sym'],
      messages: [],
      results: [{ sym: 'AAPL' }],
    }];
  };

  const preview = await driver.showRecords(
    { label: 'trade', type: ContextValue.TABLE, schema: '.analytics', database: '.analytics' },
    { limit: 25, page: 2 }
  );
  assert.strictEqual(previewQueries.length, 2);
  assert.ok(previewQueries.some(text => text.includes('(offset;limit) sublist value tbl')));
  assert.ok(previewQueries.some(text => text.includes('count value tbl')));
  assert.strictEqual(preview[0].pageSize, 25);
  assert.strictEqual(preview[0].page, 2);
  assert.strictEqual(preview[0].total, 1000000);

  const describeDriver = createDriver();
  describeDriver.query = async () => [{
    cols: ['label', 'dataType', 't', 'a'],
    messages: [],
    results: [
      { label: 'sym', dataType: 's', t: 's', a: '' },
      { label: 'history', dataType: 'J', t: 'J', a: 's' },
    ],
  }];
  const described = await describeDriver.describeTable(
    { label: 'trade', type: ContextValue.TABLE, schema: '.analytics', database: '.analytics' },
    {}
  );
  assert.deepStrictEqual(described[0].results.map(column => column.dataType), ['symbol', 'long list']);
  assert.strictEqual(described[0].results[1].detail, 'long list, attr s');

  const definitionDriver = createDriver();
  assert.strictEqual(
    await definitionDriver.getDefinitionForItem({
      item: { label: 'trade', type: ContextValue.TABLE, schema: '.analytics', database: '.analytics' },
    }),
    'meta `$".analytics.trade"'
  );
  assert.strictEqual(
    await definitionDriver.getDefinitionForItem({
      item: { label: 'tradeView', type: ContextValue.VIEW, schema: '.analytics', database: '.analytics' },
    }),
    'meta `$".analytics.tradeView"'
  );
  assert.strictEqual(
    await definitionDriver.getDefinitionForItem({
      item: { label: 'calcSpread', type: ContextValue.FUNCTION, schema: '.analytics', database: '.analytics' },
    }),
    '.Q.s1 value `$".analytics.calcSpread"'
  );

  const insertDriver = createDriver();
  const insert = await insertDriver.getInsertQuery({
    item: {
      label: 'trade',
      type: ContextValue.TABLE,
      schema: '.analytics',
      database: '.analytics',
      isView: false,
    },
    columns: [
      { label: 'sym', dataType: 'symbol' },
      { label: 'size', dataType: 'int' },
      { label: 'price', dataType: 'float' },
    ],
  });
  assert.strictEqual(insert, '(`$".analytics.trade") insert (`; 0Ni; 0n, ');
  assert.strictEqual(
    simulateSqlToolsFormatInsertQuery(insert),
    '(`$".analytics.trade") insert (`; 0Ni; 0n);'
  );

  assert.ok(connectionSchema.properties.ssh, 'connection schema should expose SSH when the driver supports SSH tunnels');
  assert.ok(connectionSchema.dependencies.ssh, 'connection schema should validate SSH options when SSH is enabled');
  assert.ok(!JSON.stringify(connectionSchema).toLowerCase().includes('tls'), 'connection schema should not expose unsupported TLS options');
  assert.ok(!JSON.stringify(connectionSchema).toLowerCase().includes('ssl'), 'connection schema should not expose unsupported SSL options');

  console.log('All kdb-sqltools tests passed.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});

function createDriver() {
  return new KdbDriver({
    id: 'test',
    name: 'test',
    driver: 'KDB',
    database: '.analytics',
    username: '',
    isConnected: false,
    isActive: false,
  }, async () => []);
}

function simulateSqlToolsFormatInsertQuery(insertQuery) {
  return `${insertQuery.substr(0, Math.max(0, insertQuery.length - 2))});`;
}
