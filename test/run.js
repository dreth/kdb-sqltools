const assert = require('assert');

const { deserializeQMessage, deserializeQPayload, qValueToTabular, serializeTextQuery } = require('../out/ls/q-ipc');
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

  const emptyTableResult = qValueToTabular(deserializeQPayload(qTable(
    ['sym', 'size'],
    [symbolVector([]), intVector([])]
  )));
  assert.deepStrictEqual(emptyTableResult.cols, ['sym', 'size']);
  assert.deepStrictEqual(emptyTableResult.rows, []);

  const keyedTableResult = qValueToTabular(deserializeQPayload(qDict(
    qTable(['sym'], [symbolVector(['AAPL', 'MSFT'])]),
    qTable(['sym', 'size'], [symbolVector(['lit', 'dark']), intVector([100, 250])])
  )));
  assert.deepStrictEqual(keyedTableResult.cols, ['sym', 'sym_1', 'size']);
  assert.deepStrictEqual(keyedTableResult.rows, [
    { sym: 'AAPL', sym_1: 'lit', size: 100 },
    { sym: 'MSFT', sym_1: 'dark', size: 250 },
  ]);

  const nestedTableResult = qValueToTabular(deserializeQPayload(qTable(
    ['sym', 'chars', 'nums', 'dict'],
    [
      symbolVector(['AAPL']),
      genericList([charVector('alpha')]),
      genericList([intVector([1, 2, 3])]),
      genericList([qDict(symbolVector(['a', 'b']), intVector([10, 20]))]),
    ]
  )));
  assert.deepStrictEqual(nestedTableResult.cols, ['sym', 'chars', 'nums', 'dict']);
  assert.deepStrictEqual(nestedTableResult.rows, [{
    sym: 'AAPL',
    chars: 'alpha',
    nums: '[1,2,3]',
    dict: '{"a":10,"b":20}',
  }]);

  const nullSymbolResult = qValueToTabular(deserializeQPayload(qTable(
    ['sym', 'label'],
    [symbolVector(['', 'MSFT']), genericList([charVector(''), charVector('ok')])]
  )));
  assert.deepStrictEqual(nullSymbolResult.rows, [
    { sym: null, label: '' },
    { sym: 'MSFT', label: 'ok' },
  ]);

  const longResult = qValueToTabular(deserializeQPayload(longVector([9007199254740993n, -9007199254740993n])));
  assert.deepStrictEqual(longResult.rows, [
    { index: 0, value: '9007199254740993' },
    { index: 1, value: '-9007199254740993' },
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
  assert.ok(
    queries.fetchRecords({
      table: { label: 'trade', schema: '.analytics', database: '.analytics' },
      limit: 10,
      offset: 5,
    }).toString().includes('}[".analytics";"trade";10;5]'),
    'preview query should use the selected table namespace from SQLTools table metadata'
  );
  assert.ok(
    queries.countRecords({
      table: { label: 'trade', schema: '.analytics', database: '.analytics' },
    }).toString().includes('}[".analytics";"trade"]'),
    'count query should use the selected table namespace from SQLTools table metadata'
  );

  assert.ok(
    queries.fetchTables({ namespace: '.missing' }).toString().includes('tbls:@[tables;`$ns;{`symbol$()}]'),
    'table metadata query should treat missing q namespaces as empty'
  );
  assert.ok(
    queries.fetchViews({ namespace: '.analytics' }).toString().includes('viewNames:$[ns~".";@[views;(::);{`symbol$()}];@[system;"b ",ns;{`symbol$()}]]'),
    'view metadata query should tolerate disabled system "b" calls'
  );
  assert.ok(
    queries.fetchFunctions({ namespace: '.analytics' }).toString().includes('fnNames:@[system;"f ",ns;{`symbol$()}]'),
    'function metadata query should tolerate disabled system "f" calls'
  );
  assert.ok(
    queries.fetchColumns({ namespace: '.analytics', table: { label: 'trade' } }).toString().includes('([] label:metaRows`c;'),
    'column metadata query should build a stable column order instead of positional update/xcol drift'
  );

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
  assert.ok(previewQueries.some(text => text.includes('}[".analytics";"trade";25;50]')));
  assert.ok(previewQueries.some(text => text.includes('}[".analytics";"trade"]')));
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

  const listDescribeDriver = createDriver();
  listDescribeDriver.query = async () => [{
    cols: ['label', 'dataType', 't', 'a'],
    messages: [],
    results: [
      { label: 'chars', dataType: 'C', t: 'C', a: '' },
      { label: 'nums', dataType: 'J', t: 'J', a: '' },
      { label: 'nested', dataType: ' ', t: ' ', a: '' },
    ],
  }];
  const listDescribed = await listDescribeDriver.describeTable(
    { label: 'edge', type: ContextValue.TABLE, schema: '.', database: '.' },
    {}
  );
  assert.deepStrictEqual(listDescribed[0].results.map(column => column.dataType), ['char list', 'long list', 'mixed']);

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

  const optionalMetadataDriver = createDriver();
  optionalMetadataDriver.query = async (query) => {
    const text = query.toString();
    if (text.includes('isView:rowCount#1b') || text.includes('resultType:rowCount#enlist "function"')) {
      return [{
        cols: [],
        messages: [],
        results: [],
        error: true,
        rawError: new Error('metadata command disabled'),
      }];
    }
    throw new Error(`unexpected optional metadata query: ${text}`);
  };

  const connectionItem = {
    label: 'test',
    type: ContextValue.CONNECTION,
    schema: '.analytics',
    database: '.analytics',
  };
  assert.deepStrictEqual(
    await optionalMetadataDriver.getChildrenForItem({
      item: {
        label: 'Views',
        type: ContextValue.RESOURCE_GROUP,
        childType: ContextValue.VIEW,
        schema: '.analytics',
        database: '.analytics',
      },
      parent: connectionItem,
    }),
    []
  );
  assert.deepStrictEqual(
    await optionalMetadataDriver.getChildrenForItem({
      item: {
        label: 'Functions',
        type: ContextValue.RESOURCE_GROUP,
        childType: ContextValue.FUNCTION,
        schema: '.analytics',
        database: '.analytics',
      },
      parent: connectionItem,
    }),
    []
  );

  const tableFailureDriver = createDriver();
  tableFailureDriver.query = async () => [{
    cols: [],
    messages: [],
    results: [],
    error: true,
    rawError: new Error('table listing failed'),
  }];
  await assert.rejects(
    () => tableFailureDriver.getChildrenForItem({
      item: {
        label: 'Tables',
        type: ContextValue.RESOURCE_GROUP,
        childType: ContextValue.TABLE,
        schema: '.analytics',
        database: '.analytics',
      },
      parent: connectionItem,
    }),
    /table listing failed/
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

function qTable(columns, vectors) {
  return Buffer.concat([
    int8(98),
    Buffer.from([0]),
    int8(99),
    symbolVector(columns),
    genericList(vectors),
  ]);
}

function qDict(keys, values) {
  return Buffer.concat([int8(99), keys, values]);
}

function genericList(items) {
  return Buffer.concat([vectorHeader(0, items.length)].concat(items));
}

function symbolVector(values) {
  return Buffer.concat([vectorHeader(11, values.length)].concat(values.map(value => cString(value))));
}

function charVector(value) {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([vectorHeader(10, body.length), body]);
}

function intVector(values) {
  const body = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => body.writeInt32LE(value, index * 4));
  return Buffer.concat([vectorHeader(6, values.length), body]);
}

function longVector(values) {
  const body = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => body.writeBigInt64LE(BigInt(value), index * 8));
  return Buffer.concat([vectorHeader(7, values.length), body]);
}

function vectorHeader(type, length) {
  const header = Buffer.alloc(6);
  header.writeInt8(type, 0);
  header.writeUInt8(0, 1);
  header.writeInt32LE(length, 2);
  return header;
}

function int8(value) {
  const buffer = Buffer.alloc(1);
  buffer.writeInt8(value, 0);
  return buffer;
}

function cString(value) {
  return Buffer.from(`${value}\0`, 'utf8');
}
