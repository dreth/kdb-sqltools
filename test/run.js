const assert = require('assert');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const net = require('net');
const path = require('path');
const JSZip = require('jszip');

const {
  KdbIpcClient,
  deserializeQMessage,
  deserializeQPayload,
  QIpcReceiveBuffer,
  qValueRowsMaterialized,
  qValueToColumnarPanel,
  qValueToQText,
  qValueToTabular,
  serializeTextQuery,
} = require('../out/ls/q-ipc');
const perfModule = require('../out/perf');
const queriesModule = require('../out/ls/queries');
const {
  CHART_MAX_SOURCE_ROWS,
  CHART_ZOOM_MAX_SAMPLED_POINTS,
  CHART_ZOOM_MIN_SAMPLED_POINTS,
  ChartDataError,
  aggregateCandlestickPoints,
  boxChartTargetGroupCount,
  boxStats,
  buildChartData,
  buildLineChartData,
  candlestickTargetPointCount,
  chartColumnOptions,
  chartTargetPointCount,
  chartTypeCapabilities,
  normalizeChartType,
} = require('../out/charting');
const { currentQBlock, selectedTextOrCurrentBlock, selectedTextOrCurrentLine } = require('../out/q-text');
const {
  allCellsRange,
  applyColumnarRowOrder,
  cellValueToText,
  columnarToCellWindow,
  compareColumnarCellText,
  createColumnarPanelResult,
  exportShape,
  filterColumnarPanelResult,
  isCellInRange,
  normalizeCellRange,
  rowsToColumnarPanelResult,
  rowsToCellWindow,
  rowsToCsv,
  rowsToHtml,
  rowsToJson,
  rowsToMarkdown,
  rowsToNdjson,
  rowsToTextFormat,
  rowsToTsv,
  rowIndexColumnName,
  sortedColumnarRowOrder,
  validateXlsxSheetLimits,
  visibleIndexRange,
} = require('../out/kdb-results');
const {
  DEFAULT_LOCAL_DATA_SERVER_PORT,
  LOCAL_DATA_SERVER_HOST,
  LOCAL_DATA_SERVER_FULL_EXPORT_CELL_LIMIT,
  LocalDataServer,
  randomLocalDataServerToken,
} = require('../out/local-data-server');
const driverModule = require('../out/ls/driver');
const KdbDriver = driverModule.default;
const { queryInNamespace } = driverModule;
const { DRIVER_ALIASES, DRIVER_ID } = require('../out/constants');
const { ContextValue } = require('@sqltools/types');
const connectionSchema = require('../connection.schema.json');
const packageJson = require('../package.json');

const queries = queriesModule.default;
const { normalizeNamespace, qString, qSymbolExpression } = queriesModule;

function hex(value) {
  return Buffer.from(value.replace(/\s/g, ''), 'hex');
}

function htmlSelectOptions(source, selectId) {
  const start = source.indexOf(`<select id="${selectId}"`);
  assert.ok(start >= 0, `${selectId} select should exist`);
  const end = source.indexOf('</select>', start);
  assert.ok(end > start, `${selectId} select should close`);
  const selectSource = source.slice(start, end);
  const matches = selectSource.match(/<option value="[^"]+">[^<]+<\/option>/g) || [];
  return matches.map(match => match.replace(/^<option value="([^"]+)">.*$/, '$1'));
}

function sourceOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function panelScrollState(physicalScrollTop, viewportHeight, rowCount, currentLayout, maxScrollPixels, scrollEndEpsilon) {
  const virtualContentHeight = currentLayout.headerHeight + rowCount * currentLayout.rowHeight;
  const physicalContentHeight = Math.min(virtualContentHeight, maxScrollPixels);
  const canvasHeight = Math.max(physicalContentHeight, viewportHeight);
  const virtualScrollableHeight = Math.max(0, virtualContentHeight - viewportHeight);
  const physicalScrollableHeight = Math.max(0, canvasHeight - viewportHeight);
  const compressed = virtualScrollableHeight > physicalScrollableHeight && physicalScrollableHeight > 0;
  const physicalTop = clampTestNumber(physicalScrollTop, 0, physicalScrollableHeight);
  const atVerticalScrollEnd = physicalScrollableHeight > 0 && physicalTop >= physicalScrollableHeight - scrollEndEpsilon;
  const virtualTop = compressed
    ? atVerticalScrollEnd
      ? virtualScrollableHeight
      : physicalTop * (virtualScrollableHeight / physicalScrollableHeight)
    : physicalTop;
  return {
    canvasHeight,
    compressed,
    physicalTop,
    virtualTop,
    virtualScrollableHeight,
    physicalScrollableHeight,
    rowOffset: Math.max(0, virtualTop - currentLayout.headerHeight),
  };
}

function panelPhysicalScrollTopForVirtual(state, virtualTop, scrollEndEpsilon) {
  const target = clampTestNumber(virtualTop, 0, state.virtualScrollableHeight);
  if (!state.compressed || state.virtualScrollableHeight <= 0) {
    return target;
  }
  if (target >= state.virtualScrollableHeight - scrollEndEpsilon) {
    return state.physicalScrollableHeight;
  }
  return target * (state.physicalScrollableHeight / state.virtualScrollableHeight);
}

function clampTestNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : min;
}

function panelFormatElapsedMs(milliseconds, display) {
  const value = Math.max(0, Math.floor(Number(milliseconds) || 0));
  if (display === 'milliseconds' || value < 1000) {
    return value + ' ms';
  }
  if (value < 60000) {
    const seconds = value / 1000;
    return (value < 10000 && value % 1000 !== 0 ? seconds.toFixed(1) : String(Math.round(seconds))) + ' s';
  }
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes + 'm' + (seconds > 0 ? ' ' + seconds + 's' : '');
}

(async () => {
  assert.strictEqual(
    serializeTextQuery('1+1').toString('hex'),
    '01010000110000000a0003000000312b31'
  );

  const scalarMessage = hex('010000000d000000fa01000000');
  const contiguousReceiveBuffer = new QIpcReceiveBuffer();
  contiguousReceiveBuffer.append(scalarMessage);
  const contiguousMessage = contiguousReceiveBuffer.readMessage();
  assert.strictEqual(contiguousMessage.toString('hex'), scalarMessage.toString('hex'));
  assert.strictEqual(contiguousMessage.buffer, scalarMessage.buffer);
  assert.strictEqual(contiguousMessage.byteOffset, scalarMessage.byteOffset);
  assert.strictEqual(contiguousReceiveBuffer.readMessage(), null);
  assert.strictEqual(contiguousReceiveBuffer.bufferedBytes, 0);
  assert.strictEqual(contiguousReceiveBuffer.copyCount, 0);
  assert.strictEqual(contiguousReceiveBuffer.copyBytesCopied, 0);

  const clearedReceiveBuffer = new QIpcReceiveBuffer();
  clearedReceiveBuffer.append(Buffer.alloc(0));
  assert.strictEqual(clearedReceiveBuffer.readMessage(), null);
  clearedReceiveBuffer.append(scalarMessage.slice(0, 8));
  assert.strictEqual(clearedReceiveBuffer.readMessage(), null);
  assert.strictEqual(clearedReceiveBuffer.bufferedBytes, 8);
  clearedReceiveBuffer.clear();
  assert.strictEqual(clearedReceiveBuffer.bufferedBytes, 0);
  clearedReceiveBuffer.append(scalarMessage);
  assert.strictEqual(clearedReceiveBuffer.readMessage().toString('hex'), scalarMessage.toString('hex'));
  assert.strictEqual(clearedReceiveBuffer.copyCount, 0);
  assert.strictEqual(clearedReceiveBuffer.copyBytesCopied, 0);

  const receiveBuffer = new QIpcReceiveBuffer();
  receiveBuffer.append(scalarMessage.slice(0, 3));
  assert.strictEqual(receiveBuffer.readMessage(), null);
  receiveBuffer.append(scalarMessage.slice(3, 8));
  assert.strictEqual(receiveBuffer.readMessage(), null);
  receiveBuffer.append(scalarMessage.slice(8, 11));
  assert.strictEqual(receiveBuffer.readMessage(), null);
  receiveBuffer.append(scalarMessage.slice(11));
  assert.strictEqual(receiveBuffer.readMessage().toString('hex'), scalarMessage.toString('hex'));
  assert.strictEqual(receiveBuffer.readMessage(), null);
  assert.strictEqual(receiveBuffer.bufferedBytes, 0);
  assert.strictEqual(receiveBuffer.copyCount, 1);
  assert.strictEqual(receiveBuffer.copyBytesCopied, scalarMessage.length);

  const invalidEndianReceiveBuffer = new QIpcReceiveBuffer();
  const invalidEndianMessage = Buffer.from(scalarMessage);
  invalidEndianMessage[0] = 2;
  invalidEndianReceiveBuffer.append(invalidEndianMessage);
  assert.throws(() => invalidEndianReceiveBuffer.readMessage(), /Invalid q IPC endian flag 2/);

  const invalidLengthMessage = Buffer.from(scalarMessage);
  invalidLengthMessage.writeInt32LE(scalarMessage.length + 1, 4);
  assert.throws(
    () => deserializeQMessage(invalidLengthMessage),
    /Invalid q IPC message length 14 for buffer length 13/
  );
  assert.throws(
    () => deserializeQPayload(hex('0a00ffffffff')),
    /Invalid q IPC vector length -1/
  );
  assert.throws(
    () => deserializeQPayload(Buffer.concat([int8(-128), cString('bad query')])),
    error => error && error.name === 'KdbQError' && /bad query/.test(error.message)
  );
  assert.throws(
    () => deserializeQPayload(Buffer.concat([intVector([1]), Buffer.from([0])])),
    /Invalid q IPC payload: 1 trailing byte\(s\)/
  );
  assert.throws(
    () => deserializeQPayload(Buffer.concat([vectorHeader(10, 4), Buffer.from('ab')])),
    /Invalid q IPC payload: unexpected end of buffer/
  );
  assert.throws(
    () => deserializeQPayload(Buffer.concat([vectorHeader(11, 1), Buffer.from('abc')])),
    /Invalid q symbol: missing terminator/
  );
  assert.throws(
    () => deserializeQPayload(vectorHeader(20, 1)),
    /Unsupported q IPC type 20/
  );
  assert.throws(
    () => deserializeQPayload(Buffer.from([98, 0, 0])),
    /Invalid q table payload: expected dictionary, got 0/
  );
  const truncatedCompressedMessage = Buffer.alloc(12);
  truncatedCompressedMessage.writeUInt8(1, 0);
  truncatedCompressedMessage.writeUInt8(2, 1);
  truncatedCompressedMessage.writeUInt8(1, 2);
  truncatedCompressedMessage.writeInt32LE(12, 4);
  truncatedCompressedMessage.writeInt32LE(16, 8);
  assert.throws(
    () => deserializeQMessage(truncatedCompressedMessage),
    /Invalid compressed q IPC message: truncated flag byte/
  );

  const queryMessage = serializeTextQuery('select from trade');
  const coalescedReceiveBuffer = new QIpcReceiveBuffer();
  const coalescedChunk = Buffer.concat([scalarMessage, queryMessage]);
  coalescedReceiveBuffer.append(coalescedChunk);
  const coalescedScalar = coalescedReceiveBuffer.readMessage();
  const coalescedQuery = coalescedReceiveBuffer.readMessage();
  assert.strictEqual(coalescedScalar.toString('hex'), scalarMessage.toString('hex'));
  assert.strictEqual(coalescedQuery.toString('hex'), queryMessage.toString('hex'));
  assert.strictEqual(coalescedScalar.buffer, coalescedChunk.buffer);
  assert.strictEqual(coalescedScalar.byteOffset, coalescedChunk.byteOffset);
  assert.strictEqual(coalescedQuery.buffer, coalescedChunk.buffer);
  assert.strictEqual(coalescedQuery.byteOffset, coalescedChunk.byteOffset + scalarMessage.length);
  assert.strictEqual(coalescedReceiveBuffer.readMessage(), null);
  assert.strictEqual(coalescedReceiveBuffer.bufferedBytes, 0);
  assert.strictEqual(coalescedReceiveBuffer.copyCount, 0);
  assert.strictEqual(coalescedReceiveBuffer.copyBytesCopied, 0);

  const closedServer = net.createServer();
  await listenTestServer(closedServer, 0, LOCAL_DATA_SERVER_HOST);
  const closedPort = closedServer.address().port;
  await closeTestServer(closedServer);
  await assertCompletesWithin(
    'closed q IPC port connect failure',
    () => assert.rejects(
      () => new KdbIpcClient({ host: LOCAL_DATA_SERVER_HOST, port: closedPort, timeoutMs: 250 }).connect(),
      error => error &&
        /kdb\+ connect failed/.test(error.message) &&
        error.message.includes(`${LOCAL_DATA_SERVER_HOST}:${closedPort}`) &&
        /ECONNREFUSED/.test(error.message)
    ),
    1000
  );

  const resetServer = net.createServer(socket => socket.destroy());
  await listenTestServer(resetServer, 0, LOCAL_DATA_SERVER_HOST);
  const resetPort = resetServer.address().port;
  try {
    await assertCompletesWithin(
      'q IPC handshake reset failure',
      () => assert.rejects(
        () => new KdbIpcClient({ host: LOCAL_DATA_SERVER_HOST, port: resetPort, timeoutMs: 250 }).connect(),
        error => error &&
          /kdb\+ handshake failed/.test(error.message) &&
          error.message.includes(`${LOCAL_DATA_SERVER_HOST}:${resetPort}`)
      ),
      1000
    );
  } finally {
    await closeTestServer(resetServer);
  }

  const heldSockets = [];
  const stalledServer = net.createServer(socket => heldSockets.push(socket));
  await listenTestServer(stalledServer, 0, LOCAL_DATA_SERVER_HOST);
  const stalledPort = stalledServer.address().port;
  const accepted = new Promise(resolve => stalledServer.once('connection', resolve));
  const stalledClient = new KdbIpcClient({ host: LOCAL_DATA_SERVER_HOST, port: stalledPort, timeoutMs: 5000 });
  const stalledConnect = stalledClient.connect();
  try {
    await accepted;
    stalledClient.cancel(new Error('test cancel'));
    await assertCompletesWithin(
      'q IPC connect cancel failure',
      () => assert.rejects(
        () => stalledConnect,
        error => error &&
          /kdb\+ (connect|handshake) failed/.test(error.message) &&
          error.message.includes(`${LOCAL_DATA_SERVER_HOST}:${stalledPort}`) &&
          /test cancel/.test(error.message)
      ),
      1000
    );
  } finally {
    heldSockets.forEach(socket => socket.destroy());
    await closeTestServer(stalledServer);
  }

  const qScript = '.data.gateway:{[query;db]\n  neg[gatewayHandle](`.gw.asyncExec;query;db)\n}\n\nselect from trade';
  assert.strictEqual(currentQBlock(qScript, 1), '.data.gateway:{[query;db]\n  neg[gatewayHandle](`.gw.asyncExec;query;db)\n}');
  assert.strictEqual(currentQBlock(qScript, 3), '');
  assert.strictEqual(currentQBlock(qScript, 4), 'select from trade');
  assert.strictEqual(selectedTextOrCurrentBlock(qScript, '1+1', 0), '1+1');
  assert.strictEqual(selectedTextOrCurrentBlock(qScript, '  ', 1), '  ');
  assert.strictEqual(selectedTextOrCurrentBlock(qScript, '', 1), '.data.gateway:{[query;db]\n  neg[gatewayHandle](`.gw.asyncExec;query;db)\n}');
  assert.strictEqual(selectedTextOrCurrentBlock(qScript, '', 3), '');
  assert.strictEqual(selectedTextOrCurrentLine(qScript, '  1+1\n2+2  ', 1), '  1+1\n2+2  ');
  assert.strictEqual(selectedTextOrCurrentLine(qScript, '', 1), '  neg[gatewayHandle](`.gw.asyncExec;query;db)');
  assert.strictEqual(selectedTextOrCurrentLine(qScript, '', 3), '');
  assert.strictEqual(selectedTextOrCurrentLine('first\r\nsecond', '', 1), 'second');
  assert.strictEqual(selectedTextOrCurrentLine('first\nsecond', '', -10), 'first');
  assert.strictEqual(selectedTextOrCurrentLine('first\nsecond', '', 99), 'second');
  assert.strictEqual(selectedTextOrCurrentLine('first\nsecond', '  ', 0), '  ');
  assert.deepStrictEqual(
    normalizeCellRange({ row: 4, column: 3 }, { row: 2, column: 6 }),
    { startRow: 2, endRow: 4, startColumn: 3, endColumn: 6 }
  );
  assert.strictEqual(isCellInRange(3, 4, { startRow: 2, endRow: 4, startColumn: 3, endColumn: 6 }), true);
  assert.strictEqual(isCellInRange(1, 4, { startRow: 2, endRow: 4, startColumn: 3, endColumn: 6 }), false);
  assert.deepStrictEqual(allCellsRange(2, 3), { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 });
  assert.strictEqual(
    rowsToTsv(
      [
        { sym: 'AAPL', note: 'line\nbreak', size: 100 },
        { sym: 'MSFT', note: null, size: 200 },
      ],
      ['sym', 'note', 'size'],
      { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }
    ),
    'AAPL\tline break\nMSFT\t'
  );
  assert.strictEqual(
    rowsToTsv(
      [
        { sym: 'AAPL', note: 'line\nbreak', size: 100 },
        { sym: 'MSFT', note: null, size: 200 },
      ],
      ['sym', 'note', 'size'],
      { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
      true
    ),
    'sym\tnote\nAAPL\tline break\nMSFT\t'
  );
  const exportRows = [
    { sym: 'AAPL', note: 'line\nbreak', size: 100, meta: { venue: 'lit' } },
    { sym: 'MSFT', note: null, size: 200, meta: [1, 2] },
  ];
  const exportColumns = ['sym', 'note', 'size', 'meta'];
  const exportRange = { startRow: 0, endRow: 1, startColumn: 1, endColumn: 3 };
  assert.strictEqual(
    rowsToCsv(
      [
        { sym: 'AAPL', note: 'plain', quote: 'a"b' },
        { sym: 'MSFT', note: 'comma, newline\nnext', quote: 'carriage\rreturn' },
      ],
      ['sym', 'note', 'quote'],
      { startRow: 0, endRow: 1, startColumn: 1, endColumn: 2 }
    ),
    'note,quote\nplain,"a""b"\n"comma, newline\nnext","carriage\rreturn"'
  );
  assert.strictEqual(
    rowsToCsv(exportRows, exportColumns, exportRange, { includeHeaders: true, includeRowIndex: true }),
    '#,note,size,meta\n1,"line\nbreak",100,"{""venue"": lit}"\n2,,200,"1, 2"'
  );
  assert.strictEqual(cellValueToText([1, 2, 3]), '1, 2, 3');
  assert.strictEqual(cellValueToText({ path: ['a', 'b'], count: 2 }), '{"path": [a, b], "count": 2}');
  assert.strictEqual(
    rowsToTsv(exportRows, exportColumns, { startRow: 0, endRow: 1, startColumn: 1, endColumn: 2 }, {
      includeHeaders: true,
      includeRowIndex: true,
    }),
    '#\tnote\tsize\n1\tline break\t100\n2\t\t200'
  );
  assert.strictEqual(
    rowsToJson(exportRows, exportColumns, exportRange),
    '[{"note":"line\\nbreak","size":100,"meta":{"venue":"lit"}},{"note":null,"size":200,"meta":[1,2]}]'
  );
  assert.strictEqual(
    rowsToJson(exportRows, exportColumns, { startRow: 0, endRow: 1, startColumn: 1, endColumn: 2 }, {
      includeRowIndex: true,
    }),
    '[{"#":1,"note":"line\\nbreak","size":100},{"#":2,"note":null,"size":200}]'
  );
  assert.strictEqual(
    rowsToNdjson(exportRows, exportColumns, { startRow: 0, endRow: 1, startColumn: 1, endColumn: 2 }),
    '{"note":"line\\nbreak","size":100}\n{"note":null,"size":200}'
  );
  assert.strictEqual(
    rowsToNdjson(exportRows, exportColumns, { startRow: 0, endRow: 1, startColumn: 1, endColumn: 2 }, {
      includeRowIndex: true,
    }),
    '{"#":1,"note":"line\\nbreak","size":100}\n{"#":2,"note":null,"size":200}'
  );
  assert.strictEqual(
    rowsToHtml(
      [{ sym: 'A&B', note: '<tag "x" \'', nums: [1, 2, 3] }],
      ['sym', 'note', 'nums'],
      { startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 }
    ),
    '<table><thead><tr><th>sym</th><th>note</th><th>nums</th></tr></thead><tbody><tr><td>A&amp;B</td><td>&lt;tag &quot;x&quot; &#39;</td><td>1, 2, 3</td></tr></tbody></table>'
  );
  assert.strictEqual(
    rowsToHtml(
      [{ sym: 'A&B', note: '<tag "x" \'' }],
      ['sym', 'note'],
      { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 },
      { includeHeaders: true, includeRowIndex: true }
    ),
    '<table><thead><tr><th>#</th><th>sym</th><th>note</th></tr></thead><tbody><tr><td>1</td><td>A&amp;B</td><td>&lt;tag &quot;x&quot; &#39;</td></tr></tbody></table>'
  );
  assert.strictEqual(
    rowsToMarkdown(
      [{ sym: 'A|B', note: 'line\nbreak', path: 'c:\\tmp' }],
      ['sym', 'note', 'path'],
      { startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 },
      { includeHeaders: true, includeRowIndex: true }
    ),
    '| # | sym | note | path |\n| --- | --- | --- | --- |\n| 1 | A\\|B | line<br>break | c:\\\\tmp |'
  );
  assert.strictEqual(rowsToTextFormat(exportRows, exportColumns, exportRange, 'ndjson'), rowsToNdjson(exportRows, exportColumns, exportRange));
  assert.strictEqual(
    rowsToTextFormat(exportRows, exportColumns, exportRange, 'markdown', { includeHeaders: true, includeRowIndex: true }),
    rowsToMarkdown(exportRows, exportColumns, exportRange, { includeHeaders: true, includeRowIndex: true })
  );
  assert.strictEqual(
    rowsToTextFormat(exportRows, exportColumns, exportRange, 'csv', { includeHeaders: true, includeRowIndex: true }),
    rowsToCsv(exportRows, exportColumns, exportRange, { includeHeaders: true, includeRowIndex: true })
  );
  assert.strictEqual(
    rowIndexColumnName(['#', '#_1', 'sym'], { startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 }),
    '#_2'
  );
  assert.deepStrictEqual(
    rowsToCellWindow(
      [
        { sym: 'AAPL', note: 'line\nbreak', size: 100 },
        { sym: 'MSFT', note: null, size: 200 },
      ],
      ['sym', 'note', 'size'],
      { start: 0, end: 1 },
      { start: 1, end: 2 }
    ),
    {
      startRow: 0,
      endRow: 1,
      startColumn: 1,
      endColumn: 2,
      cells: [
        ['line break', '100'],
        ['', '200'],
      ],
    }
  );
  const rowBackedColumnar = rowsToColumnarPanelResult(
    [
      { sym: 'AAPL', note: 'line\nbreak', size: 100 },
      { sym: 'MSFT', note: null, size: 200 },
    ],
    ['sym', 'note', 'size']
  );
  assert.deepStrictEqual(
    columnarToCellWindow(rowBackedColumnar, { start: 0, end: 1 }, { start: 1, end: 2 }),
    rowsToCellWindow(
      [
        { sym: 'AAPL', note: 'line\nbreak', size: 100 },
        { sym: 'MSFT', note: null, size: 200 },
      ],
      ['sym', 'note', 'size'],
      { start: 0, end: 1 },
      { start: 1, end: 2 }
    )
  );
  assert.strictEqual(
    rowBackedColumnar.toText('csv', { startRow: 0, endRow: 1, startColumn: 1, endColumn: 2 }, {
      includeHeaders: true,
      includeRowIndex: true,
    }),
    '#,note,size\n1,"line\nbreak",100\n2,,200'
  );
  const directColumnar = createColumnarPanelResult(['sym', 'note'], 2, (rowIndex, columnIndex) => {
    const values = [
      ['A|B', 'line\nbreak'],
      ['MSFT', 'plain'],
    ];
    return values[rowIndex][columnIndex];
  });
  assert.strictEqual(
    directColumnar.toText('markdown', { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }, {
      includeHeaders: true,
      includeRowIndex: true,
    }),
    '| # | sym | note |\n| --- | --- | --- |\n| 1 | A\\|B | line<br>break |\n| 2 | MSFT | plain |'
  );
  assert.deepStrictEqual(
    rowBackedColumnar.cellWindow({ start: -10, end: 50 }, { start: -10, end: 50 }),
    {
      startRow: 0,
      endRow: 1,
      startColumn: 0,
      endColumn: 2,
      cells: [
        ['AAPL', 'line break', '100'],
        ['MSFT', '', '200'],
      ],
    }
  );
  assert.deepStrictEqual(
    rowBackedColumnar.cellWindow({ start: 1, end: 0 }, { start: 0, end: 1 }),
    { startRow: 0, endRow: -1, startColumn: 0, endColumn: -1, cells: [] }
  );
  const arrayColumnar = rowsToColumnarPanelResult(
    [{ nums: [4000, 4001, 4002], nested: [[1, 2], [3, 4]] }],
    ['nums', 'nested']
  );
  assert.strictEqual(cellValueToText([4000, 4001, 4002]), '4000, 4001, 4002');
  assert.strictEqual(/,\s{2,}/.test(cellValueToText([4000, 4001, 4002])), false);
  assert.strictEqual(cellValueToText([4000, 4001, 4002]).includes(' ,'), false);
  assert.deepStrictEqual(
    arrayColumnar.cellWindow({ start: 0, end: 0 }, { start: 0, end: 1 }).cells,
    [['4000, 4001, 4002', '[1, 2], [3, 4]']]
  );
  assert.deepStrictEqual(
    arrayColumnar.cellWindow({ start: 0, end: 0 }, { start: 0, end: 1 }, { arrayDisplayFormat: 'space' }).cells,
    [['4000 4001 4002', '[1 2] [3 4]']]
  );
  assert.deepStrictEqual(
    arrayColumnar.cellWindow({ start: 0, end: 0 }, { start: 0, end: 1 }, { arrayDisplayFormat: 'raw' }).cells,
    [['[4000 4001 4002]', '[[1 2] [3 4]]']]
  );
  assert.strictEqual(
    arrayColumnar.toText('csv', { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }, { includeHeaders: true }),
    'nums\n"4000, 4001, 4002"'
  );
  assert.strictEqual(
    arrayColumnar.toText('tsv', { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }, {
      includeHeaders: true,
      arrayDisplayFormat: 'space',
    }),
    'nums\n4000 4001 4002'
  );
  assert.strictEqual(
    arrayColumnar.toText('markdown', { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }, {
      includeHeaders: true,
      arrayDisplayFormat: 'raw',
    }),
    '| nums |\n| --- |\n| [4000 4001 4002] |'
  );
  assert.strictEqual(
    arrayColumnar.toText('json', { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }, { arrayDisplayFormat: 'raw' }),
    '[{"nums":[4000,4001,4002]}]'
  );
  const escapingColumnar = rowsToColumnarPanelResult(
    [{ '#': 'user', note: '<&>"\'' }],
    ['#', 'note']
  );
  assert.strictEqual(
    escapingColumnar.toText('csv', { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 }, {
      includeHeaders: true,
      includeRowIndex: true,
    }),
    '#_1,#,note\n1,user,"<&>""\'"'
  );
  assert.strictEqual(
    escapingColumnar.toText('html', { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 }, {
      includeHeaders: true,
      includeRowIndex: true,
    }),
    '<table><thead><tr><th>#_1</th><th>#</th><th>note</th></tr></thead><tbody><tr><td>1</td><td>user</td><td>&lt;&amp;&gt;&quot;&#39;</td></tr></tbody></table>'
  );
  const visibleColumnar = filterColumnarPanelResult(rowBackedColumnar, ['sym', 'size']);
  assert.deepStrictEqual(visibleColumnar.columns, ['sym', 'size']);
  const reorderedVisibleColumnar = filterColumnarPanelResult(rowBackedColumnar, ['size', 'sym']);
  assert.deepStrictEqual(reorderedVisibleColumnar.columns, ['size', 'sym']);
  assert.deepStrictEqual(
    reorderedVisibleColumnar.cellWindow({ start: 0, end: 0 }, { start: 0, end: 1 }).cells,
    [['100', 'AAPL']]
  );
  assert.deepStrictEqual(
    visibleColumnar.cellWindow({ start: 0, end: 1 }, { start: 0, end: 1 }),
    {
      startRow: 0,
      endRow: 1,
      startColumn: 0,
      endColumn: 1,
      cells: [
        ['AAPL', '100'],
        ['MSFT', '200'],
      ],
    }
  );
  assert.strictEqual(
    visibleColumnar.toText('csv', { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }, {
      includeHeaders: true,
      includeRowIndex: false,
    }),
    'sym,size\nAAPL,100\nMSFT,200'
  );
  const sortableColumnar = rowsToColumnarPanelResult(
    [
      { sym: 'A', size: '10', flag: true, day: '2024.01.02' },
      { sym: 'B', size: '2', flag: false, day: '2024.01.01' },
      { sym: 'C', size: '10', flag: false, day: '' },
      { sym: 'D', size: '2', flag: true, day: '2023.12.31' },
      { sym: 'E', size: '', flag: false, day: '2024.01.01' },
    ],
    ['sym', 'size', 'flag', 'day']
  );
  assert.strictEqual(compareColumnarCellText('', '1', 'asc') > 0, true);
  assert.strictEqual(compareColumnarCellText('', '1', 'desc') > 0, true);
  assert.strictEqual(compareColumnarCellText('10', '2', 'asc') > 0, true);
  assert.strictEqual(compareColumnarCellText('false', 'true', 'asc') < 0, true);
  assert.strictEqual(compareColumnarCellText('2024.01.02', '2024.01.01', 'asc') > 0, true);
  assert.deepStrictEqual(sortedColumnarRowOrder(sortableColumnar, 1, 'asc'), [1, 3, 0, 2, 4]);
  assert.deepStrictEqual(sortedColumnarRowOrder(sortableColumnar, 1, 'desc'), [0, 2, 1, 3, 4]);
  assert.deepStrictEqual(sortedColumnarRowOrder(sortableColumnar, 2, 'asc'), [1, 2, 4, 0, 3]);
  assert.deepStrictEqual(sortedColumnarRowOrder(sortableColumnar, 3, 'asc'), [3, 1, 4, 0, 2]);
  const orderedColumnar = applyColumnarRowOrder(sortableColumnar, [1, 3, 0]);
  assert.deepStrictEqual(orderedColumnar.cellWindow({ start: 0, end: 2 }, { start: 0, end: 1 }).cells, [
    ['B', '2'],
    ['D', '2'],
    ['A', '10'],
  ]);
  const filteredSortable = filterColumnarPanelResult(sortableColumnar, ['sym', 'size']);
  assert.deepStrictEqual(filteredSortable.columns, ['sym', 'size']);
  assert.deepStrictEqual(sortedColumnarRowOrder(filteredSortable, 1, 'asc'), [1, 3, 0, 2, 4]);
  const filteredOrderedColumnar = applyColumnarRowOrder(filteredSortable, sortedColumnarRowOrder(filteredSortable, 1, 'asc'));
  assert.deepStrictEqual(
    filteredOrderedColumnar.cellWindow({ start: 0, end: 2 }, { start: 0, end: 1 }).cells,
    [
      ['B', '2'],
      ['D', '2'],
      ['A', '10'],
    ]
  );
  assert.strictEqual(
    filteredOrderedColumnar.toText('json', { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }, {
      includeRowIndex: true,
    }),
    '[{"#":1,"sym":"B","size":"2"},{"#":2,"sym":"D","size":"2"}]'
  );
  assert.deepStrictEqual(
    applyColumnarRowOrder(sortableColumnar, [3, -1, 99, 1.9, Number.NaN]).cellWindow({ start: 0, end: 1 }, { start: 0, end: 0 }).cells,
    [['D'], ['B']]
  );
  assert.deepStrictEqual(sortableColumnar.cellWindow({ start: 0, end: 0 }, { start: 0, end: 1 }).cells, [['A', '10']]);
  assert.deepStrictEqual(visibleIndexRange(280, 140, 28, 100, 2), { start: 8, end: 17 });
  assert.deepStrictEqual(visibleIndexRange(-100, 140, 28, 100, 2), { start: 0, end: 4 });
  assert.deepStrictEqual(visibleIndexRange(0, 0, 28, 100, 2), { start: 0, end: -1 });
  assert.strictEqual(panelFormatElapsedMs(123, 'auto'), '123 ms');
  assert.strictEqual(panelFormatElapsedMs(1500, 'auto'), '1.5 s');
  assert.strictEqual(panelFormatElapsedMs(63000, 'auto'), '1m 3s');
  assert.strictEqual(panelFormatElapsedMs(63000, 'milliseconds'), '63000 ms');
  [1, 10, 1800000, 10000000].forEach(rowCount => {
    [20, 24, 28, 32, 80].forEach(rowHeight => {
      const viewportHeight = 600;
      const state = panelScrollState(
        Number.MAX_SAFE_INTEGER,
        viewportHeight,
        rowCount,
        { headerHeight: Math.min(Math.max(rowHeight + 4, 24), 88), rowHeight },
        8000000,
        1
      );
      const rows = visibleIndexRange(state.rowOffset, viewportHeight, rowHeight, rowCount, 8);
      assert.strictEqual(rows.end, rowCount - 1, `physical max must reach final row for ${rowCount} rows at ${rowHeight}px`);
      assert.strictEqual(
        panelPhysicalScrollTopForVirtual(state, state.virtualScrollableHeight, 1),
        state.physicalScrollableHeight,
        'virtual max must reverse-map to physical max'
      );
    });
  });
  assert.deepStrictEqual(
    exportShape({ startRow: 0, endRow: 1048574, startColumn: 0, endColumn: 16382 }, {
      includeHeaders: true,
      includeRowIndex: true,
    }),
    {
      selectedRows: 1048575,
      selectedColumns: 16383,
      outputRows: 1048576,
      outputColumns: 16384,
      selectedCells: 1048575 * 16383,
      outputCells: 1048576 * 16384,
    }
  );
  assert.strictEqual(
    validateXlsxSheetLimits({ startRow: 0, endRow: 1048574, startColumn: 0, endColumn: 16382 }, {
      includeHeaders: true,
      includeRowIndex: true,
    }),
    null
  );
  assert.ok(/rows/.test(validateXlsxSheetLimits(
    { startRow: 0, endRow: 1048575, startColumn: 0, endColumn: 0 },
    { includeHeaders: true, includeRowIndex: false }
  )));
  assert.ok(/columns/.test(validateXlsxSheetLimits(
    { startRow: 0, endRow: 0, startColumn: 0, endColumn: 16383 },
    { includeHeaders: false, includeRowIndex: true }
  )));

  const chartTable = rowsToColumnarPanelResult(
    [
      { ts: '2024-01-03', price: 10, size: 100, sym: 'A' },
      { ts: '2024-01-01', price: null, size: 200, sym: 'B' },
      { ts: '2024-01-02', price: Infinity, size: 300, sym: 'C' },
      { ts: '2024-01-04', price: 5, size: 400, sym: 'D' },
    ],
    ['ts', 'price', 'size', 'sym']
  );
  const chartOptions = chartColumnOptions(chartTable);
  assert.deepStrictEqual(chartOptions.xColumns.map(option => `${option.columnName}:${option.kind}`), [
    'ts:temporal',
    'price:numeric',
    'size:numeric',
  ]);
  assert.deepStrictEqual(chartOptions.yColumns.map(option => option.columnName), ['price', 'size']);
  assert.deepStrictEqual(chartOptions.groupColumns.map(option => `${option.columnName}:${option.kind}`), ['sym:categorical']);
  assert.strictEqual(normalizeChartType('CANDLESTICK'), 'candlestick');
  assert.strictEqual(normalizeChartType('unknown'), 'line');
  assert.deepStrictEqual(chartTypeCapabilities('line'), {
    usesGenericY: true,
    supportsGroupBy: true,
    usesOhlc: false,
  });
  assert.deepStrictEqual(chartTypeCapabilities('box'), {
    usesGenericY: true,
    supportsGroupBy: false,
    usesOhlc: false,
  });
  assert.deepStrictEqual(chartTypeCapabilities('candlestick'), {
    usesGenericY: false,
    supportsGroupBy: false,
    usesOhlc: true,
  });

  const candleTable = rowsToColumnarPanelResult(
    [
      { ts: '2024-01-02', open: 20, high: 24, low: 18, close: 21, sym: 'A' },
      { ts: '2024-01-01', open: 10, high: 13, low: 9, close: 12, sym: 'A' },
      { ts: '2024-01-02', open: 21, high: 25, low: 17, close: 23, sym: 'A' },
    ],
    ['ts', 'open', 'high', 'low', 'close', 'sym']
  );
  const candleRequest = {
    chartType: 'candlestick',
    version: 3,
    requestId: 11,
    xColumn: 'ts',
    openColumn: 'open',
    highColumn: 'high',
    lowColumn: 'low',
    closeColumn: 'close',
    width: 800,
  };
  const candleChart = buildChartData(candleTable, candleRequest);
  assert.strictEqual(candleChart.chartType, 'candlestick');
  assert.strictEqual(candleChart.sorted, true);
  assert.deepStrictEqual(candleChart.ohlcColumns, {
    open: 'open',
    high: 'high',
    low: 'low',
    close: 'close',
  });
  assert.deepStrictEqual(candleChart.candlesticks, [
    { x: Date.parse('2024-01-01'), xText: '2024-01-01', open: 10, high: 13, low: 9, close: 12 },
    { x: Date.parse('2024-01-02'), xText: '2024-01-02', open: 20, high: 25, low: 17, close: 23 },
  ]);
  assert.deepStrictEqual(candleChart.series.map(series => series.columnName), ['OHLC']);
  assert.deepStrictEqual(candleChart.series[0].values, [12, 23]);
  assert.strictEqual(candleChart.algorithm, 'ohlc-exact/2');
  assert.deepStrictEqual(candleChart.xDomain, {
    min: Date.parse('2024-01-01'),
    max: Date.parse('2024-01-02'),
  });
  assert.ok(candleChart.warnings.some(warning => /distinct x candles/.test(warning)));
  const numericXCandleChart = buildChartData(rowsToColumnarPanelResult(
    [{ x: 1, open: 10, high: 12, low: 8, close: 11 }],
    ['x', 'open', 'high', 'low', 'close']
  ), { ...candleRequest, xColumn: 'x' });
  assert.strictEqual(numericXCandleChart.xKind, 'numeric');
  assert.deepStrictEqual(numericXCandleChart.x, [1]);
  assert.throws(
    () => buildChartData(candleTable, { ...candleRequest, openColumn: '' }),
    /Select a numeric Open column/
  );
  assert.throws(
    () => buildChartData(candleTable, { ...candleRequest, closeColumn: 'open' }),
    /four distinct numeric columns/
  );
  assert.throws(
    () => buildChartData(candleTable, { ...candleRequest, openColumn: 'sym' }),
    /Open column sym is not eligible as a numeric column/
  );
  assert.throws(
    () => buildChartData(candleTable, { ...candleRequest, groupByColumn: 'sym' }),
    /Group by is not supported for candlestick charts/
  );

  const missingCandleTable = rowsToColumnarPanelResult(
    [
      { x: 1, open: null, high: 12, low: 8, close: 11 },
      { x: 2, open: 11, high: 13, low: 10, close: 12 },
    ],
    ['x', 'open', 'high', 'low', 'close']
  );
  assert.throws(
    () => buildChartData(missingCandleTable, { ...candleRequest, xColumn: 'x' }),
    /Open column open is missing at row 1/
  );
  const lateInvalidCandleTable = createColumnarPanelResult(
    ['x', 'open', 'high', 'low', 'close'],
    201,
    (rowIndex, columnIndex) => {
      if (columnIndex === 0) {
        return rowIndex;
      }
      if (columnIndex === 1) {
        return rowIndex === 200 ? 'not-a-number' : 10;
      }
      return columnIndex === 2 ? 12 : columnIndex === 3 ? 8 : 11;
    }
  );
  assert.throws(
    () => buildChartData(lateInvalidCandleTable, { ...candleRequest, xColumn: 'x' }),
    /Open column open must contain a finite numeric value at row 201/
  );
  const badHighCandleTable = rowsToColumnarPanelResult(
    [{ x: 1, open: 10, high: 9, low: 7, close: 8 }],
    ['x', 'open', 'high', 'low', 'close']
  );
  assert.throws(
    () => buildChartData(badHighCandleTable, { ...candleRequest, xColumn: 'x' }),
    /High 9 must be greater than or equal to Open and Close/
  );
  const reversedHighLowCandleTable = rowsToColumnarPanelResult(
    [{ x: 1, open: 10, high: 9, low: 11, close: 10 }],
    ['x', 'open', 'high', 'low', 'close']
  );
  assert.throws(
    () => buildChartData(reversedHighLowCandleTable, { ...candleRequest, xColumn: 'x' }),
    /High 9 must be greater than or equal to Low 11/
  );
  const badLowCandleTable = rowsToColumnarPanelResult(
    [{ x: 1, open: 10, high: 13, low: 11, close: 12 }],
    ['x', 'open', 'high', 'low', 'close']
  );
  assert.throws(
    () => buildChartData(badLowCandleTable, { ...candleRequest, xColumn: 'x' }),
    /Low 11 must be less than or equal to Open and Close/
  );

  const aggregatedCandles = aggregateCandlestickPoints([
    { rowIndex: 0, x: 1, xText: '1', open: 10, high: 12, low: null, close: 11 },
    { rowIndex: 1, x: 1, xText: '1', open: null, high: 15, low: 8, close: 13 },
    { rowIndex: 2, x: 2, xText: '2', open: 14, high: 18, low: 12, close: 17 },
    { rowIndex: 3, x: 3, xText: '3', open: 20, high: 23, low: 19, close: 22 },
    { rowIndex: 4, x: 4, xText: '4', open: 22, high: 26, low: 21, close: 25 },
  ], 2);
  assert.strictEqual(aggregatedCandles.exactPointCount, 4);
  assert.strictEqual(aggregatedCandles.algorithm, 'ohlc-bucket/2');
  assert.deepStrictEqual(aggregatedCandles.xDomain, { min: 1, max: 4 });
  assert.deepStrictEqual(aggregatedCandles.candlesticks, [
    { x: 1.5, xText: '1..2', open: 10, high: 18, low: 8, close: 17 },
    { x: 3.5, xText: '3..4', open: 20, high: 26, low: 19, close: 25 },
  ]);
  const irregularCandles = aggregateCandlestickPoints([
    { x: 0, xText: '0', open: 10, high: 12, low: 9, close: 11 },
    { x: 1, xText: '1', open: 11, high: 13, low: 10, close: 12 },
    { x: 2, xText: '2', open: 12, high: 14, low: 11, close: 13 },
    { x: 100000, xText: '100000', open: 20, high: 23, low: 19, close: 22 },
  ], 2);
  assert.deepStrictEqual(irregularCandles.xDomain, { min: 0, max: 100000 });
  assert.deepStrictEqual(irregularCandles.candlesticks.map(candle => candle.x), [1, 100000]);
  assert.deepStrictEqual(irregularCandles.candlesticks.map(candle => candle.xText), ['0..2', '100000']);
  const oneIrregularCandle = aggregateCandlestickPoints([
    { x: 0, xText: '0', open: 10, high: 12, low: 9, close: 11 },
    { x: 100000, xText: '100000', open: 20, high: 23, low: 19, close: 22 },
  ], 1);
  assert.deepStrictEqual(oneIrregularCandle.xDomain, { min: 0, max: 100000 });
  assert.strictEqual(oneIrregularCandle.candlesticks[0].x, 50000);
  assert.strictEqual(candlestickTargetPointCount(800), 800);
  assert.strictEqual(candlestickTargetPointCount(800, 300), 300);
  const denseCandleChart = buildChartData(createColumnarPanelResult(
    ['x', 'open', 'high', 'low', 'close'],
    350,
    (rowIndex, columnIndex) => {
      if (columnIndex === 0) {
        return rowIndex;
      }
      const open = rowIndex + 10;
      return columnIndex === 1 ? open : columnIndex === 2 ? open + 2 : columnIndex === 3 ? open - 2 : open + 1;
    }
  ), { ...candleRequest, xColumn: 'x', width: 100 });
  assert.strictEqual(denseCandleChart.sampledPointCount, 100);
  assert.strictEqual(denseCandleChart.algorithm, 'ohlc-bucket/100');

  const unsortedChart = buildLineChartData(chartTable, {
    version: 2,
    requestId: 3,
    xColumn: 'ts',
    yColumns: ['price'],
    width: 800,
  });
  assert.strictEqual(unsortedChart.sorted, true);
  assert.strictEqual(unsortedChart.chartType, 'line');
  assert.deepStrictEqual(unsortedChart.xText, ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04']);
  assert.deepStrictEqual(unsortedChart.series[0].values, [null, null, 10, 5]);
  assert.ok(unsortedChart.warnings.some(warning => /sorted/.test(warning)));
  assert.ok(unsortedChart.warnings.some(warning => /Null and non-finite/.test(warning)));
  const scatterChart = buildChartData(chartTable, {
    chartType: 'scatter',
    version: 2,
    requestId: 4,
    xColumn: 'ts',
    yColumns: ['price', 'size'],
    width: 800,
  });
  assert.strictEqual(scatterChart.chartType, 'scatter');
  assert.deepStrictEqual(scatterChart.series.map(series => series.columnName), ['price', 'size']);
  const groupedChart = buildChartData(chartTable, {
    chartType: 'line',
    version: 2,
    requestId: 5,
    xColumn: 'ts',
    yColumns: ['size'],
    groupByColumn: 'sym',
    width: 800,
  });
  assert.strictEqual(groupedChart.groupByColumn, 'sym');
  assert.deepStrictEqual(groupedChart.series.map(series => series.columnName), [
    'size [B]',
    'size [C]',
    'size [A]',
    'size [D]',
  ]);
  assert.deepStrictEqual(groupedChart.series[0].values, [200, null, null, null]);
  assert.deepStrictEqual(groupedChart.series[2].values, [null, null, 100, null]);
  assert.deepStrictEqual(groupedChart.series[0].gapFlags, [false, false, false, false]);
  assert.deepStrictEqual(groupedChart.series[2].gapFlags, [false, false, false, false]);
  const groupedGapTable = rowsToColumnarPanelResult(
    [
      { x: 1, value: null, group: 'A' },
      { x: 2, value: 2, group: 'B' },
      { x: 3, value: 3, group: 'A' },
    ],
    ['x', 'value', 'group']
  );
  const groupedGapChart = buildChartData(groupedGapTable, {
    chartType: 'line',
    version: 2,
    requestId: 51,
    xColumn: 'x',
    yColumns: ['value'],
    groupByColumn: 'group',
    width: 800,
  });
  assert.deepStrictEqual(groupedGapChart.series.map(series => series.columnName), ['value [A]', 'value [B]']);
  assert.deepStrictEqual(groupedGapChart.series[0].values, [null, null, 3]);
  assert.deepStrictEqual(groupedGapChart.series[0].gapFlags, [true, false, false]);
  assert.deepStrictEqual(groupedGapChart.series[1].values, [null, 2, null]);
  assert.deepStrictEqual(groupedGapChart.series[1].gapFlags, [false, false, false]);
  const alignedGroupedChart = buildChartData(rowsToColumnarPanelResult(
    [
      { x: 1, value: 10, group: 'A' },
      { x: 1, value: 20, group: 'B' },
      { x: 2, value: 30, group: 'A' },
      { x: 2, value: 40, group: 'B' },
    ],
    ['x', 'value', 'group']
  ), {
    chartType: 'line',
    version: 2,
    requestId: 511,
    xColumn: 'x',
    yColumns: ['value'],
    groupByColumn: 'group',
    width: 800,
  });
  assert.deepStrictEqual(alignedGroupedChart.x, [1, 2]);
  assert.deepStrictEqual(alignedGroupedChart.series.map(series => series.values), [[10, 30], [20, 40]]);
  assert.ok(alignedGroupedChart.warnings.some(warning => /aligned 4 grouped rows into 2 distinct x positions/.test(warning)));
  assert.throws(
    () => buildChartData(rowsToColumnarPanelResult(
      [
        { x: 1, value: 10, group: 'A' },
        { x: 1, value: 11, group: 'A' },
        { x: 1, value: 20, group: 'B' },
      ],
      ['x', 'value', 'group']
    ), {
      chartType: 'step',
      version: 2,
      requestId: 512,
      xColumn: 'x',
      yColumns: ['value'],
      groupByColumn: 'group',
      width: 800,
    }),
    /Step chart grouping has multiple finite values for value \[A\] at x 1/
  );
  const groupedWithoutEmptySeries = buildChartData(rowsToColumnarPanelResult(
    [
      { x: 1, value: null, group: 'empty' },
      { x: 2, value: 2, group: 'finite' },
    ],
    ['x', 'value', 'group']
  ), {
    chartType: 'scatter',
    version: 2,
    requestId: 513,
    xColumn: 'x',
    yColumns: ['value'],
    groupByColumn: 'group',
    width: 800,
  });
  assert.deepStrictEqual(groupedWithoutEmptySeries.series.map(series => series.columnName), ['value [finite]']);
  assert.ok(groupedWithoutEmptySeries.warnings.some(warning => /omitted 1 category with no finite selected y values/.test(warning)));
  const sparseGroupYColumns = Array.from({ length: 10 }, (_value, index) => `y${index}`);
  const sparseGroupedChart = buildChartData(rowsToColumnarPanelResult(
    Array.from({ length: 10 }, (_value, groupIndex) => {
      const row = { x: groupIndex, group: `g${groupIndex}` };
      sparseGroupYColumns.forEach((columnName, yIndex) => {
        row[columnName] = yIndex === groupIndex ? groupIndex + 1 : null;
      });
      return row;
    }),
    ['x'].concat(sparseGroupYColumns, ['group'])
  ), {
    chartType: 'scatter',
    version: 2,
    requestId: 514,
    xColumn: 'x',
    yColumns: sparseGroupYColumns,
    groupByColumn: 'group',
    width: 800,
  });
  assert.strictEqual(sparseGroupedChart.series.length, 10, 'sparse finite combinations should determine the generated-series cap');
  assert.deepStrictEqual(sparseGroupedChart.series.map(series => series.columnName), sparseGroupYColumns.map((columnName, index) => `${columnName} [g${index}]`));
  assert.ok(sparseGroupedChart.warnings.some(warning => /omitted 90 group\/Y combinations with no finite values/.test(warning)));
  const zoomRangeChart = buildChartData(chartTable, {
    chartType: 'line',
    version: 2,
    requestId: 6,
    xColumn: 'ts',
    yColumns: ['size'],
    xMin: Date.parse('2024-01-02'),
    xMax: Date.parse('2024-01-03'),
    width: 800,
  });
  assert.deepStrictEqual(zoomRangeChart.xText, ['2024-01-02', '2024-01-03']);
  assert.ok(zoomRangeChart.warnings.some(warning => /outside the selected x range/.test(warning)));
  assert.throws(
    () => buildChartData(chartTable, {
      chartType: 'box',
      version: 2,
      requestId: 7,
      xColumn: 'ts',
      yColumns: ['size'],
      groupByColumn: 'sym',
      width: 800,
    }),
    /Group by is not supported/
  );

  const groupedBarTable = rowsToColumnarPanelResult(
    [
      { x: 1, value: 10, group: 'A' },
      { x: 1, value: 20, group: 'B' },
      { x: 2, value: 30, group: 'A' },
      { x: 2, value: 40, group: 'B' },
    ],
    ['x', 'value', 'group']
  );
  const groupedBarChart = buildChartData(groupedBarTable, {
    chartType: 'bar',
    version: 2,
    requestId: 52,
    xColumn: 'x',
    yColumns: ['value'],
    groupByColumn: 'group',
    width: 800,
  });
  assert.deepStrictEqual(groupedBarChart.x, [1, 2]);
  assert.deepStrictEqual(groupedBarChart.series.map(series => series.values), [[10, 30], [20, 40]]);
  assert.deepStrictEqual(groupedBarChart.series.map(series => series.gapFlags), [[false, false], [false, false]]);
  assert.strictEqual(groupedBarChart.algorithm, 'bar-cluster/2');
  assert.ok(groupedBarChart.warnings.some(warning => /distinct x clusters without stacking overlapping bars/.test(warning)));
  const duplicateGroupedBarTable = rowsToColumnarPanelResult(
    [
      { x: 1, value: 10, group: 'A' },
      { x: 1, value: 11, group: 'A' },
      { x: 1, value: 20, group: 'B' },
    ],
    ['x', 'value', 'group']
  );
  assert.throws(
    () => buildChartData(duplicateGroupedBarTable, {
      chartType: 'bar',
      version: 2,
      requestId: 53,
      xColumn: 'x',
      yColumns: ['value'],
      groupByColumn: 'group',
      width: 800,
    }),
    /multiple finite values for value \[A\] at x 1/
  );
  const oneBarCluster = buildChartData(rowsToColumnarPanelResult(
    [{ x: 1, value: 10 }, { x: 2, value: 20 }],
    ['x', 'value']
  ), {
    chartType: 'bar',
    version: 2,
    requestId: 54,
    xColumn: 'x',
    yColumns: ['value'],
    width: 1,
    maxSampledPoints: 1,
  });
  assert.deepStrictEqual(oneBarCluster.x, [1]);
  assert.deepStrictEqual(oneBarCluster.xDomain, { min: 1, max: 2 });
  assert.deepStrictEqual(oneBarCluster.series[0].values, [10]);
  assert.strictEqual(oneBarCluster.algorithm, 'bar-cluster-even/1');

  const spikeTable = createColumnarPanelResult(['x', 'y'], 100, (rowIndex, columnIndex) => {
    if (columnIndex === 0) {
      return rowIndex;
    }
    return rowIndex === 50 ? 999 : 0;
  });
  const sampledChart = buildLineChartData(spikeTable, {
    version: 1,
    requestId: 1,
    xColumn: 'x',
    yColumns: ['y'],
    width: 10,
    maxSampledPoints: 10,
  });
  assert.strictEqual(sampledChart.algorithm, 'minmax-bucket/10');
  assert.ok(sampledChart.sampledPointCount <= 10);
  assert.ok(sampledChart.series[0].values.includes(999), 'min/max chart sampling should preserve spikes');
  const sampledGapChart = buildLineChartData(createColumnarPanelResult(['x', 'y'], 100, (rowIndex, columnIndex) => {
    return columnIndex === 0 ? rowIndex : (rowIndex === 55 ? null : rowIndex);
  }), {
    version: 1,
    requestId: 2,
    xColumn: 'x',
    yColumns: ['y'],
    width: 10,
    maxSampledPoints: 10,
  });
  assert.ok(sampledGapChart.sampledPointCount <= 10);
  assert.ok(sampledGapChart.series[0].values.includes(null), 'min/max chart sampling should retain a source gap sample');
  assert.ok(chartTargetPointCount(1000) < 1000000, 'chart target should not send million-point series by default');
  const zoomAllRowsTable = createColumnarPanelResult(['x', 'y'], 5000, (rowIndex, columnIndex) => {
    return columnIndex === 0 ? rowIndex : rowIndex * 2;
  });
  const zoomAllRowsChart = buildLineChartData(zoomAllRowsTable, {
    version: 1,
    requestId: 3,
    xColumn: 'x',
    yColumns: ['y'],
    xMin: 0,
    xMax: 4999,
    width: 10,
    maxSampledPoints: CHART_ZOOM_MAX_SAMPLED_POINTS,
  });
  assert.strictEqual(zoomAllRowsChart.algorithm, 'none');
  assert.strictEqual(zoomAllRowsChart.sampledPointCount, 5000);
  const zoomSampledRowsTable = createColumnarPanelResult(['x', 'y'], 9000, (rowIndex, columnIndex) => {
    return columnIndex === 0 ? rowIndex : (rowIndex === 4500 ? 999 : rowIndex);
  });
  const zoomSampledRowsChart = buildLineChartData(zoomSampledRowsTable, {
    version: 1,
    requestId: 4,
    xColumn: 'x',
    yColumns: ['y'],
    xMin: 0,
    xMax: 8999,
    width: 10,
    maxSampledPoints: CHART_ZOOM_MAX_SAMPLED_POINTS,
  });
  assert.strictEqual(zoomSampledRowsChart.algorithm, `minmax-bucket/${CHART_ZOOM_MAX_SAMPLED_POINTS}`);
  assert.ok(zoomSampledRowsChart.sampledPointCount <= CHART_ZOOM_MAX_SAMPLED_POINTS);
  assert.ok(zoomSampledRowsChart.series[0].values.includes(999), 'zoom min/max sampling should preserve spikes');
  assert.throws(
    () => buildLineChartData(spikeTable, {
      version: 1,
      requestId: 1,
      xColumn: 'x',
      yColumns: ['y'],
      width: 800,
      maxSourceRows: 50,
    }),
    error => error instanceof ChartDataError && /limit/.test(error.message)
  );
  const highCapChart = buildLineChartData(spikeTable, {
    version: 1,
    requestId: 2,
    xColumn: 'x',
    yColumns: ['y'],
    width: 800,
    maxSourceRows: 1000000000000,
  });
  assert.strictEqual(highCapChart.sourceRowCount, 100);
  assert.strictEqual(highCapChart.requestId, 2);
  assert.throws(
    () => buildLineChartData(chartTable, {
      version: 1,
      requestId: 1,
      xColumn: 'sym',
      yColumns: ['price'],
      width: 800,
    }),
    /not eligible/
  );
  assert.deepStrictEqual(boxStats([1, 2, 3, 4]), {
    count: 4,
    min: 1,
    q1: 1.75,
    median: 2.5,
    q3: 3.25,
    max: 4,
  });
  assert.strictEqual(boxStats([NaN, Infinity]), null);
  assert.ok(boxChartTargetGroupCount(1000, 2, 800) <= 120);
  const boxTable = rowsToColumnarPanelResult(
    [
      { bucket: 2, price: 10, size: 100 },
      { bucket: 1, price: 1, size: 10 },
      { bucket: 1, price: 3, size: 30 },
      { bucket: 2, price: 20, size: 200 },
      { bucket: 2, price: 30, size: null },
    ],
    ['bucket', 'price', 'size']
  );
  const boxChart = buildChartData(boxTable, {
    chartType: 'box',
    version: 7,
    requestId: 8,
    xColumn: 'bucket',
    yColumns: ['price', 'size'],
    width: 800,
  });
  assert.strictEqual(boxChart.chartType, 'box');
  assert.strictEqual(boxChart.algorithm, 'box-exact/2');
  assert.deepStrictEqual(boxChart.x, [1, 2]);
  assert.deepStrictEqual(boxChart.series[0].values, [2, 20]);
  assert.deepStrictEqual(boxChart.boxSeries[0].stats[0], {
    count: 2,
    min: 1,
    q1: 1.5,
    median: 2,
    q3: 2.5,
    max: 3,
  });
  assert.strictEqual(boxChart.boxSeries[1].stats[1].count, 2);
  assert.deepStrictEqual(boxChart.xDomain, { min: 1, max: 2 });
  assert.ok(boxChart.warnings.some(warning => /skipped for box statistics/.test(warning)));
  const irregularBoxChart = buildChartData(createColumnarPanelResult(['x', 'y'], 121, (rowIndex, columnIndex) => {
    const x = rowIndex === 120 ? 100000 : rowIndex;
    return columnIndex === 0 ? x : x + 1;
  }), {
    chartType: 'box',
    version: 7,
    requestId: 81,
    xColumn: 'x',
    yColumns: ['y'],
    width: 320,
  });
  assert.strictEqual(irregularBoxChart.algorithm, 'box-bucket/120');
  assert.deepStrictEqual(irregularBoxChart.xDomain, { min: 0, max: 100000 });
  assert.strictEqual(irregularBoxChart.x[irregularBoxChart.x.length - 1], (119 + 100000) / 2);
  assert.strictEqual(irregularBoxChart.xText[irregularBoxChart.xText.length - 1], '119..100000');
  const binnedBoxChart = buildChartData(spikeTable, {
    chartType: 'box',
    version: 1,
    requestId: 9,
    xColumn: 'x',
    yColumns: ['y'],
    width: 20,
    maxSampledPoints: 8,
  });
  assert.strictEqual(binnedBoxChart.chartType, 'box');
  assert.strictEqual(binnedBoxChart.sampledPointCount, 8);
  assert.strictEqual(binnedBoxChart.algorithm, 'box-bucket/8');
  assert.ok(binnedBoxChart.warnings.some(warning => /x buckets/.test(warning)));
  const repeatedBoxRows = [];
  for (let index = 0; index < 17; index++) {
    repeatedBoxRows.push({ x: 1, value: index + 1 });
  }
  for (let x = 2; x <= 10; x++) {
    repeatedBoxRows.push({ x, value: x * 10 });
  }
  const repeatedXBoxChart = buildChartData(rowsToColumnarPanelResult(
    repeatedBoxRows,
    ['x', 'value']
  ), {
    chartType: 'box',
    version: 1,
    requestId: 10,
    xColumn: 'x',
    yColumns: ['value'],
    width: 20,
    maxSampledPoints: 8,
  });
  assert.strictEqual(repeatedXBoxChart.sampledPointCount, 8);
  assert.ok(repeatedXBoxChart.x.every((value, index, values) => index === 0 || value > values[index - 1]), 'box buckets must not split or repeat an equal x run');
  assert.ok(repeatedXBoxChart.boxSeries[0].stats[0].count >= 17, 'the repeated x run must stay in one complete box bucket');

  assert.strictEqual(DEFAULT_LOCAL_DATA_SERVER_PORT, 7742);
  assert.strictEqual(LOCAL_DATA_SERVER_HOST, '127.0.0.1');
  assert.strictEqual(randomLocalDataServerToken().length, 48);
  const blocker = http.createServer((_request, response) => response.end('busy'));
  await listenTestServer(blocker, 0, LOCAL_DATA_SERVER_HOST);
  const blockedPort = blocker.address().port;
  let selectionRange;
  let localServerSnapshot = {
    metadata: {
      version: 7,
      columns: ['time', 'price'],
      query: 'select from trade',
      connectionName: 'local kdb',
    },
    table: rowsToColumnarPanelResult(
      [
        { time: '2024-01-01', price: 1.5, sym: 'AAPL' },
        { time: '2024-01-02', price: 2.5, sym: 'MSFT' },
      ],
      ['time', 'price']
    ),
    cellTextOptions: { arrayDisplayFormat: 'commaSpace' },
  };
  const localDataServer = new LocalDataServer({
    preferredPort: blockedPort,
    provider: {
      current: () => ({ ...localServerSnapshot, selectionRange }),
    },
  });
  let stoppedLocalDataUrl = '';
  try {
    const serverInfo = await localDataServer.start();
    stoppedLocalDataUrl = `${serverInfo.baseUrl}/current.csv`;
    assert.strictEqual(serverInfo.host, LOCAL_DATA_SERVER_HOST);
    assert.notStrictEqual(serverInfo.port, blockedPort, 'busy preferred port should fall forward');
    assert.ok(serverInfo.baseUrl.startsWith(`http://${LOCAL_DATA_SERVER_HOST}:`));
    assert.ok(serverInfo.baseUrl.endsWith(`/${serverInfo.token}`));

    let response = await httpGet(`${serverInfo.baseUrl}/metadata.json`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(JSON.parse(response.body).connectionName, 'local kdb');
    assert.deepStrictEqual(JSON.parse(response.body).visibleColumns, ['time', 'price']);

    response = await httpGet(`${serverInfo.baseUrl}/current.csv`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body, 'time,price\n2024-01-01,1.5\n2024-01-02,2.5');

    response = await httpGet(`${serverInfo.baseUrl}/current.json`);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(JSON.parse(response.body), [
      { time: '2024-01-01', price: 1.5 },
      { time: '2024-01-02', price: 2.5 },
    ]);

    response = await httpGet(`${serverInfo.baseUrl}/current.ndjson`);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body.split('\n'), [
      '{"time":"2024-01-01","price":1.5}',
      '{"time":"2024-01-02","price":2.5}',
    ]);

    response = await httpGet(`${serverInfo.baseUrl}/slice.csv?rowStart=1&rowCount=1&colStart=1&colCount=1`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body, 'price\n2.5');

    response = await httpGet(`${serverInfo.baseUrl}/slice.json?rowStart=0&rowCount=1&colStart=0&colCount=1`);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(JSON.parse(response.body), [{ time: '2024-01-01' }]);

    response = await httpGet(`${serverInfo.baseUrl}/selection.json`);
    assert.strictEqual(response.status, 400);
    assert.strictEqual(JSON.parse(response.body).error.code, 'no_selection');
    selectionRange = { startRow: 0, endRow: 0, startColumn: 1, endColumn: 1 };
    response = await httpGet(`${serverInfo.baseUrl}/selection.json`);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(JSON.parse(response.body), [{ price: 1.5 }]);

    response = await httpGet(`http://${serverInfo.host}:${serverInfo.port}/bad-token/current.csv`);
    assert.strictEqual(response.status, 404);
    assert.strictEqual(JSON.parse(response.body).error.code, 'unknown_token');

    response = await httpGet(`${serverInfo.baseUrl}/slice.csv?rowStart=-1&rowCount=1&colStart=0&colCount=1`);
    assert.strictEqual(response.status, 400);
    assert.strictEqual(JSON.parse(response.body).error.code, 'invalid_slice');

    const bigColumnCount = 1001;
    localServerSnapshot = {
      metadata: { version: 8, columns: [] },
      table: createColumnarPanelResult(
        Array.from({ length: bigColumnCount }, (_unused, index) => `c${index}`),
        Math.ceil(LOCAL_DATA_SERVER_FULL_EXPORT_CELL_LIMIT / bigColumnCount) + 1,
        () => 1
      ),
      cellTextOptions: {},
    };
    response = await httpGet(`${serverInfo.baseUrl}/current.csv`);
    assert.strictEqual(response.status, 413);
    assert.strictEqual(JSON.parse(response.body).error.code, 'full_export_too_large');
  } finally {
    await localDataServer.stop();
    await closeTestServer(blocker);
  }
  await assert.rejects(
    () => httpGet(stoppedLocalDataUrl),
    /ECONNREFUSED|socket hang up|ECONNRESET/
  );

  const resultsPanelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'results-panel.ts'), 'utf8');
  const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const driverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ls', 'driver.ts'), 'utf8');
  const qIpcSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ls', 'q-ipc.ts'), 'utf8');
  const kdbResultsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'kdb-results.ts'), 'utf8');
  const chartingSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'charting.ts'), 'utf8');
  const perfSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'perf.ts'), 'utf8');
  const readmeSource = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const chartingDocsSource = fs.readFileSync(path.join(__dirname, '..', 'mkdocs-src', 'charting.md'), 'utf8');
  const localDataDocsSource = fs.readFileSync(path.join(__dirname, '..', 'mkdocs-src', 'local-data-server.md'), 'utf8');
  const copyExportDocsSource = fs.readFileSync(path.join(__dirname, '..', 'mkdocs-src', 'copy-export.md'), 'utf8');
  const runningDocsSource = fs.readFileSync(path.join(__dirname, '..', 'mkdocs-src', 'running-q.md'), 'utf8');
  const resultsDocsSource = fs.readFileSync(path.join(__dirname, '..', 'mkdocs-src', 'results-panel.md'), 'utf8');
  const settingsDocsSource = fs.readFileSync(path.join(__dirname, '..', 'mkdocs-src', 'settings.md'), 'utf8');
  const troubleshootingDocsSource = fs.readFileSync(path.join(__dirname, '..', 'mkdocs-src', 'troubleshooting.md'), 'utf8');
  const packageSource = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
  const commandTitle = commandId => packageJson.contributes.commands.find(command => command.command === commandId).title;
  const keybinding = commandId => packageJson.contributes.keybindings.find(binding => binding.command === commandId);
  assert.strictEqual(resultsPanelSource.includes('innerHTML'), false, 'kdb results panel must not render grid cells via innerHTML');
  assert.strictEqual(resultsPanelSource.includes(' style="'), false, 'kdb results panel must not rely on inline style attributes for virtual grid positioning');
  assert.strictEqual(resultsPanelSource.includes('createElement'), true, 'kdb results panel should create positioned grid cells as DOM nodes');
  assert.strictEqual(resultsPanelSource.includes('const MAX_SCROLL_PIXELS = 8000000;'), true);
  assert.strictEqual(resultsPanelSource.includes('const SCROLL_END_EPSILON = 1;'), true);
  assert.strictEqual(resultsPanelSource.includes('function scrollState(physicalScrollTop, viewportHeight, rowCount, currentLayout)'), true);
  assert.strictEqual(resultsPanelSource.includes('const physicalContentHeight = Math.min(virtualContentHeight, MAX_SCROLL_PIXELS);'), true);
  assert.strictEqual(resultsPanelSource.includes('const atVerticalScrollEnd = physicalScrollableHeight > 0 && physicalTop >= physicalScrollableHeight - SCROLL_END_EPSILON;'), true);
  assert.strictEqual(resultsPanelSource.includes('? virtualScrollableHeight'), true);
  assert.strictEqual(resultsPanelSource.includes('physicalTop * (virtualScrollableHeight / physicalScrollableHeight)'), true);
  assert.strictEqual(resultsPanelSource.includes('function physicalScrollTopForVirtual(state, virtualTop)'), true);
  assert.strictEqual(resultsPanelSource.includes('return state.physicalScrollableHeight;'), true);
  assert.strictEqual(resultsPanelSource.includes('target * (state.physicalScrollableHeight / state.virtualScrollableHeight)'), true);
  assert.strictEqual(resultsPanelSource.includes('function horizontalScrollState(physicalScrollLeft, viewportWidth, totalWidth)'), true);
  assert.strictEqual(resultsPanelSource.includes('const physicalContentWidth = Math.min(virtualContentWidth, MAX_SCROLL_PIXELS);'), true);
  assert.strictEqual(resultsPanelSource.includes('function physicalLeftForVirtual(state, virtualLeft)'), true);
  assert.strictEqual(resultsPanelSource.includes("canvas.style.height = verticalState.canvasHeight + 'px';"), true);
  assert.strictEqual(resultsPanelSource.includes('const rows = visibleRange(verticalState.rowOffset'), true);
  assert.strictEqual(resultsPanelSource.includes('function variableVisibleColumnRange(offset, size, metrics, overscan)'), true);
  assert.strictEqual(resultsPanelSource.includes('column * layout.cellWidth'), false);
  assert.strictEqual(resultsPanelSource.includes('rowElement.style.top = renderedRowTop(row, verticalState, layout)'), true);
  assert.strictEqual(resultsPanelSource.includes('rowElement.style.top = (layout.headerHeight + row * layout.rowHeight)'), false);
  assert.deepStrictEqual(htmlSelectOptions(resultsPanelSource, 'actionFormat'), ['csv', 'xlsx', 'tsv', 'json', 'ndjson', 'html', 'markdown']);
  assert.strictEqual(resultsPanelSource.includes('id="toolsMenu"'), false);
  assert.strictEqual(resultsPanelSource.includes('<summary id="toolsSummary">Tools</summary>'), false);
  assert.strictEqual(resultsPanelSource.includes('class="tools-panel"'), false);
  assert.strictEqual(resultsPanelSource.includes('id="dataToolsSection"'), false);
  assert.strictEqual(resultsPanelSource.includes('id="chartToolsSection"'), false);
  assert.strictEqual(resultsPanelSource.includes('id="viewToolsSection"'), false);
  assert.strictEqual(resultsPanelSource.includes('class="tools-section"'), false);
  assert.strictEqual(resultsPanelSource.includes('function updateToolbarOverflow()'), false);
  assert.strictEqual(resultsPanelSource.includes("toolbar.classList.toggle('toolbar-overflow', shouldOverflow);"), false);
  assert.strictEqual(resultsPanelSource.includes("document.addEventListener('click', event => {"), true);
  assert.strictEqual(resultsPanelSource.includes("event.key === 'Escape' && closeToolbarMenus(true)"), true);
  const toolbarSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('<div id="resultsToolbar"'),
    resultsPanelSource.indexOf('<div id="message"')
  );
  const outputControlsSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('<div id="outputControls"'),
    resultsPanelSource.indexOf('<button id="openChart"')
  );
  const inlineOutputOptionsSource = outputControlsSource.slice(
    outputControlsSource.indexOf('<span id="inlineOutputOptions"'),
    outputControlsSource.indexOf('<button id="copy"')
  );
  const chartButtonSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('<button id="openChart"'),
    resultsPanelSource.indexOf('<details id="settingsMenu"')
  );
  const settingsMenuSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('<details id="settingsMenu"'),
    resultsPanelSource.indexOf('<button id="cancelQuery"')
  );
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="actionFormat"'), 1);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="includeHeaders"'), 1);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="includeRowIndex"'), 1);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="searchInput"'), 1);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="interactionMode"'), 1);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="chartType"'), 1);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="chartGroupColumn"'), 1);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="refineChartZoom"'), 1);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="chartSplitter"'), 1);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="cancelQuery"'), 1);
  assert.ok(toolbarSource.indexOf('id="outputControls"') < toolbarSource.indexOf('id="openChart"'));
  assert.ok(toolbarSource.indexOf('id="openChart"') < toolbarSource.indexOf('id="settingsMenu"'));
  assert.ok(toolbarSource.indexOf('id="settingsMenu"') < toolbarSource.indexOf('id="cancelQuery"'));
  assert.ok(toolbarSource.indexOf('id="cancelQuery"') < toolbarSource.indexOf('<span id="spinner"'));
  assert.strictEqual(resultsPanelSource.includes('<button id="cancelQuery" class="cancel-query" title="Cancel running q query" aria-label="Cancel running q query" hidden disabled>Cancel</button>'), true);
  assert.strictEqual(resultsPanelSource.includes('>Cancel query</button>'), false);
  assert.strictEqual(resultsPanelSource.includes("vscode.postMessage({ type: 'cancelRunningQuery', version: data.version });"), true);
  assert.strictEqual(resultsPanelSource.includes("message.type === 'cancelRunningQuery'"), true);
  assert.strictEqual(resultsPanelSource.includes('private runningQueryCancel: { version: number; cancel(): void } | undefined;'), true);
  assert.strictEqual(resultsPanelSource.includes('public setLoadingCancelHandler(version: number, cancel: () => void): vscode.Disposable'), true);
  const setLoadingSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function setLoading'),
    resultsPanelSource.indexOf('function setResultMeta')
  );
  const setResultMetaSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function setResultMeta'),
    resultsPanelSource.indexOf('function setSlice')
  );
  assert.strictEqual(setLoadingSource.includes('cancelQuery.hidden = false;'), true);
  assert.strictEqual(setLoadingSource.includes('cancelQuery.disabled = false;'), true);
  assert.strictEqual(setResultMetaSource.includes('cancelQuery.hidden = true;'), true);
  assert.strictEqual(setResultMetaSource.includes('cancelQuery.disabled = true;'), true);
  assert.strictEqual(outputControlsSource.includes('id="outputControlsLabel" class="toolbar-group-label">Output:</span>'), true);
  assert.strictEqual(outputControlsSource.includes('role="group" aria-labelledby="outputControlsLabel"'), true);
  assert.ok(outputControlsSource.indexOf('id="actionFormat"') < outputControlsSource.indexOf('id="includeHeaders"'));
  assert.ok(outputControlsSource.indexOf('id="includeHeaders"') < outputControlsSource.indexOf('id="includeRowIndex"'));
  assert.ok(outputControlsSource.indexOf('id="includeRowIndex"') < outputControlsSource.indexOf('id="copy"'));
  assert.ok(outputControlsSource.indexOf('id="copy"') < outputControlsSource.indexOf('id="export"'));
  assert.strictEqual(inlineOutputOptionsSource.includes('id="includeHeaders"'), true);
  assert.strictEqual(inlineOutputOptionsSource.includes('id="includeRowIndex"'), true);
  assert.strictEqual(inlineOutputOptionsSource.includes('title="Include column headers in copied/exported output"'), true);
  assert.strictEqual(inlineOutputOptionsSource.includes('title="Include row numbers in copied/exported output"'), true);
  assert.strictEqual(resultsPanelSource.includes('function placeOutputOptions(inToolsMenu)'), false);
  assert.strictEqual(resultsPanelSource.includes('id="overflowOutputOptions"'), false);
  assert.strictEqual(resultsPanelSource.includes('<details id="chartMenu"'), false);
  assert.strictEqual(resultsPanelSource.includes('id="chartMenuStatus"'), false);
  assert.strictEqual(chartButtonSource.includes('<button id="openChart" class="chart-open-button" disabled title="Open chart" aria-label="Open chart">Chart</button>'), true);
  assert.strictEqual(chartButtonSource.includes('Open chart</button>'), false);
  assert.strictEqual(toolbarSource.includes('id="chartType"'), false);
  assert.ok(resultsPanelSource.indexOf('id="chartPanel"') < resultsPanelSource.indexOf('id="chartType"'));
  assert.deepStrictEqual(htmlSelectOptions(resultsPanelSource, 'chartType'), ['line', 'scatter', 'step', 'bar', 'box', 'candlestick']);
  assert.strictEqual(settingsMenuSource.includes('<summary id="settingsSummary" aria-label="Settings menu">Settings</summary>'), true);
  assert.strictEqual(settingsMenuSource.includes('role="group" aria-label="Settings controls"'), true);
  assert.strictEqual(resultsPanelSource.includes('overflow-x: hidden;'), true);
  assert.strictEqual(resultsPanelSource.includes('.settings-panel * {\n      max-width: 100%;\n      min-width: 0;\n    }'), true);
  assert.strictEqual(resultsPanelSource.includes('grid-template-columns: minmax(0, 1fr) 94px;'), false);
  assert.strictEqual(resultsPanelSource.includes('.settings-row > span {\n      overflow-wrap: anywhere;\n    }'), true);
  assert.strictEqual(settingsMenuSource.includes('<span>View</span>'), true);
  assert.strictEqual(settingsMenuSource.includes('id="autoFit"'), true);
  assert.strictEqual(settingsMenuSource.includes('id="interactionMode"'), true);
  assert.strictEqual(settingsMenuSource.includes('<option value="drag">Drag</option>'), true);
  assert.strictEqual(settingsMenuSource.includes('<option value="select">Select</option>'), true);
  assert.strictEqual(settingsMenuSource.includes('<option value="sort">Sort</option>'), true);
  assert.strictEqual(settingsMenuSource.includes('id="searchInput"'), true);
  assert.strictEqual(settingsMenuSource.includes('<span>Data server</span>'), true);
  assert.strictEqual(settingsMenuSource.includes('id="localDataServerBadge" class="tool-summary-status">Stopped</span>'), true);
  assert.strictEqual(settingsMenuSource.includes('id="localDataServerBaseUrl" class="tool-menu-note" hidden'), true);
  assert.strictEqual(settingsMenuSource.includes('id="startLocalDataServer"'), true);
  assert.strictEqual(settingsMenuSource.includes('id="stopLocalDataServer"'), true);
  assert.strictEqual(settingsMenuSource.includes('id="copyCurrentCsvUrl"'), true);
  assert.strictEqual(settingsMenuSource.includes('id="copyMetadataUrl"'), true);
  assert.strictEqual(settingsMenuSource.includes('Start server'), true);
  assert.strictEqual(settingsMenuSource.includes('Stop server'), true);
  assert.strictEqual(settingsMenuSource.includes('Copy current.csv URL'), true);
  assert.strictEqual(settingsMenuSource.includes('Copy metadata URL'), true);
  assert.strictEqual(settingsMenuSource.includes('<span>Preferences</span>'), true);
  assert.strictEqual(settingsMenuSource.includes('<span>Columns</span>'), true);
  assert.strictEqual(resultsPanelSource.includes('id="dataServerMenu"'), false);
  assert.strictEqual(resultsPanelSource.includes("localDataServerStatus.textContent = server\n          ? 'Server: ' + server.host + ':' + server.port"), false);
  assert.strictEqual(resultsPanelSource.includes("localDataServerBaseUrl.textContent = server ? 'Base URL: ' + String(server.baseUrl || '') : '';"), true);
  assert.strictEqual(resultsPanelSource.includes("chartMenuStatus.textContent = chartPanel.hidden"), false);
  assert.strictEqual(resultsPanelSource.includes('chartMenu.open = false;'), false);
  assert.strictEqual(resultsPanelSource.includes('id="chartPanel"'), true);
  assert.strictEqual(resultsPanelSource.includes('id="exportChart" hidden disabled'), true);
  assert.strictEqual(resultsPanelSource.includes('id="resetChartZoom" disabled'), true);
  assert.strictEqual(resultsPanelSource.includes('id="refineChartZoom" disabled'), true);
  assert.strictEqual(resultsPanelSource.includes('role="separator" aria-orientation="horizontal"'), true);
  assert.strictEqual(resultsPanelSource.includes('function chartCanExport()'), true);
  assert.strictEqual(resultsPanelSource.includes('function chartCanRefineZoom()'), true);
  assert.strictEqual(resultsPanelSource.includes('function currentChartZoomRange()'), true);
  assert.strictEqual(resultsPanelSource.includes('function startChartResize(event)'), true);
  assert.strictEqual(resultsPanelSource.includes('exportChart.hidden = !canExport;'), true);
  assert.strictEqual(resultsPanelSource.includes('uPlot.iife.min.js'), true);
  assert.strictEqual(resultsPanelSource.includes('uPlot.min.css'), true);
  assert.strictEqual(resultsPanelSource.includes("path.join(context.extensionPath, 'node_modules', 'uplot', 'dist')"), true);
  assert.strictEqual(resultsPanelSource.includes('localResourceRoots: [uplotDistRoot]'), true);
  assert.strictEqual(resultsPanelSource.includes('script-src ${cspSource}'), true);
  assert.strictEqual(resultsPanelSource.includes('new window.uPlot(chartUPlotOptions(dimensions), chartAlignedData(), chartPlot)'), true);
  assert.strictEqual(resultsPanelSource.includes('function selectedChartType()'), true);
  assert.strictEqual(resultsPanelSource.includes('chartType: selectedChartType()'), true);
  assert.strictEqual(resultsPanelSource.includes('groupByColumn: selectedChartGroupColumn()'), true);
  assert.strictEqual(resultsPanelSource.includes('message.xMin = xRange.min;'), true);
  assert.strictEqual(resultsPanelSource.includes('Chart settings changed — Render to update.'), true);
  assert.strictEqual(resultsPanelSource.includes("chartData.chartType === 'box'"), true);
  assert.strictEqual(resultsPanelSource.includes('Box charts use numeric Y columns; Group by is unavailable.'), true);
  assert.strictEqual(resultsPanelSource.includes('window.uPlot.paths.stepped'), true);
  assert.strictEqual(resultsPanelSource.includes('function drawChartBars(self)'), true);
  assert.strictEqual(resultsPanelSource.includes('function drawChartBoxes(self)'), true);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="chartGroupField"'), 1);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="chartOhlcColumns"'), 1);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="chartOpenColumn"'), 1);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="chartHighColumn"'), 1);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="chartLowColumn"'), 1);
  assert.strictEqual(sourceOccurrences(resultsPanelSource, 'id="chartCloseColumn"'), 1);
  assert.strictEqual(resultsPanelSource.includes('role="group" aria-label="Candlestick OHLC columns"'), true);
  assert.strictEqual(resultsPanelSource.includes('aria-label="Open column"'), true);
  assert.strictEqual(resultsPanelSource.includes('aria-label="High column"'), true);
  assert.strictEqual(resultsPanelSource.includes('aria-label="Low column"'), true);
  assert.strictEqual(resultsPanelSource.includes('aria-label="Close column"'), true);
  const chartTypeControlsSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function updateChartTypeControls()'),
    resultsPanelSource.indexOf('function chartTypeSupportsGroup')
  );
  assert.strictEqual(chartTypeControlsSource.includes('chartGroupField.hidden = !supportsGroup;'), true);
  assert.strictEqual(chartTypeControlsSource.includes('chartGroupColumn.disabled = !supportsGroup'), true);
  assert.strictEqual(chartTypeControlsSource.includes('chartYColumns.hidden = candlestick;'), true);
  assert.strictEqual(chartTypeControlsSource.includes('input.disabled = candlestick;'), true);
  assert.strictEqual(chartTypeControlsSource.includes('chartOhlcColumns.hidden = !candlestick;'), true);
  const chartTypeSupportSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function chartTypeSupportsGroup'),
    resultsPanelSource.indexOf('function onChartTypeChanged')
  );
  assert.strictEqual(chartTypeSupportSource.includes("type === 'line' || type === 'scatter' || type === 'step' || type === 'bar'"), true);
  assert.strictEqual(chartTypeSupportSource.includes("type === 'box'"), false);
  assert.strictEqual(chartTypeSupportSource.includes("type === 'candlestick'"), false);
  const chartTypeChangeSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function onChartTypeChanged()'),
    resultsPanelSource.indexOf('function onChartControlChanged()')
  );
  assert.strictEqual(chartTypeChangeSource.includes('updateChartTypeControls();'), true);
  assert.strictEqual(chartTypeChangeSource.includes('destroyChartPlot'), false);
  assert.strictEqual(chartTypeChangeSource.includes('drawChart'), false);
  const chartControlChangeSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function onChartControlChanged()'),
    resultsPanelSource.indexOf('function clearChartRendered()')
  );
  assert.strictEqual(chartControlChangeSource.includes('destroyChartPlot'), false);
  assert.strictEqual(chartControlChangeSource.includes('clearChartRendered'), false);
  assert.strictEqual(chartControlChangeSource.includes('chartRendered = null'), false);
  const selectedChartYSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function selectedChartYColumns()'),
    resultsPanelSource.indexOf('function selectedChartGroupColumn()')
  );
  assert.strictEqual(selectedChartYSource.includes("selectedChartType() === 'candlestick'"), true);
  assert.strictEqual(selectedChartYSource.includes('return [];'), true);
  assert.strictEqual(resultsPanelSource.includes('Group by is unavailable for candlesticks.'), true);
  const chartAlignedDataSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function chartAlignedData()'),
    resultsPanelSource.indexOf('function chartUPlotOptions')
  );
  assert.strictEqual(chartAlignedDataSource.includes('series.gapFlags[index] === true ? null : undefined'), true);
  assert.strictEqual(resultsPanelSource.includes('Number.isFinite(Number(item)) ? Number(item) : null'), false);
  const candlestickDrawSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function drawChartCandlesticks(self)'),
    resultsPanelSource.indexOf('function chartCandlestickColors()')
  );
  assert.strictEqual(candlestickDrawSource.includes("chartData.chartType !== 'candlestick'"), true);
  assert.strictEqual(candlestickDrawSource.includes('candle.high'), true);
  assert.strictEqual(candlestickDrawSource.includes('candle.low'), true);
  assert.strictEqual(candlestickDrawSource.includes('candle.open'), true);
  assert.strictEqual(candlestickDrawSource.includes('candle.close'), true);
  assert.strictEqual(candlestickDrawSource.includes('ctx.moveTo(center, highY);'), true);
  assert.strictEqual(candlestickDrawSource.includes('ctx.lineTo(center, lowY);'), true);
  assert.strictEqual(candlestickDrawSource.includes('rising ? colors.hollow : color'), true);
  assert.strictEqual(candlestickDrawSource.includes('Math.max(1 * pxRatio, Math.min(18 * pxRatio'), true);
  assert.strictEqual(resultsPanelSource.includes("draw: type === 'candlestick'\n              ? [drawChartCandlesticks]"), true);
  const candleTooltipSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function updateChartTooltipFromUPlot(self)'),
    resultsPanelSource.indexOf('function chartOhlcTooltipLabel')
  );
  assert.strictEqual(candleTooltipSource.includes("chartData.chartType === 'candlestick'"), true);
  assert.strictEqual(candleTooltipSource.includes("chartOhlcTooltipLabel('Open'"), true);
  assert.strictEqual(candleTooltipSource.includes("chartOhlcTooltipLabel('High'"), true);
  assert.strictEqual(candleTooltipSource.includes("chartOhlcTooltipLabel('Low'"), true);
  assert.strictEqual(candleTooltipSource.includes("chartOhlcTooltipLabel('Close'"), true);
  const barDrawSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function drawChartBars(self)'),
    resultsPanelSource.indexOf('function chartBarClusterWidthPixels')
  );
  assert.strictEqual(barDrawSource.includes("chartData.chartType !== 'bar'"), true);
  assert.strictEqual(barDrawSource.includes("self.valToPos(0, 'y', true)"), true);
  assert.strictEqual(barDrawSource.includes('slotWidth * seriesIndex + slotWidth / 2'), true);
  assert.strictEqual(barDrawSource.includes('const maxBodyWidth = Math.max(Number.EPSILON, slotWidth * 0.86);'), true);
  assert.strictEqual(barDrawSource.includes('const barWidth = Math.max(Number.EPSILON, Math.min(28 * pxRatio, maxBodyWidth));'), true);
  assert.strictEqual(barDrawSource.includes('Math.min(28 * pxRatio, maxBodyWidth)'), true);
  assert.strictEqual(barDrawSource.includes('Dense bar clusters too narrow to distinguish were skipped'), true);
  assert.strictEqual(resultsPanelSource.includes('window.uPlot.paths.bars'), false);
  const chartYScaleSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function chartYScaleRange(min, max)'),
    resultsPanelSource.indexOf('function chartCandlestickYRange()')
  );
  assert.strictEqual(chartYScaleSource.includes("chartData.chartType === 'bar'"), true);
  assert.strictEqual(chartYScaleSource.includes('low = Math.min(0, low);'), true);
  assert.strictEqual(chartYScaleSource.includes('high = Math.max(0, high);'), true);
  const boxDrawSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function drawChartBoxes(self)'),
    resultsPanelSource.indexOf('function drawOneBox')
  );
  assert.strictEqual(boxDrawSource.includes('slotWidth < 1.75 * pxRatio'), true);
  assert.strictEqual(boxDrawSource.includes('Dense box groups too narrow to distinguish were skipped'), true);
  assert.strictEqual(boxDrawSource.includes('slotWidth * 0.72'), true);
  assert.strictEqual(boxDrawSource.includes('slotWidth - Math.max(1, pxRatio)'), true);
  assert.strictEqual(resultsPanelSource.includes('function chartThinnedXAxisLabels(self, splits)'), true);
  assert.strictEqual(resultsPanelSource.includes('function chartTemporalTickLabel(self, value)'), true);
  assert.strictEqual(resultsPanelSource.includes('function chartMaxVisibleXAxisLabels(self, labels)'), true);
  assert.strictEqual(resultsPanelSource.includes('values: (self, splits) => chartThinnedXAxisLabels(self, splits)'), true);
  assert.strictEqual(resultsPanelSource.includes('drag: { setScale: true, x: true, y: false, dist: 5 }'), true);
  assert.strictEqual(resultsPanelSource.includes('function resetChartZoom()'), true);
  assert.strictEqual(resultsPanelSource.includes('let chartFullXRange = null;'), true);
  const resetChartZoomSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function resetChartZoom()'),
    resultsPanelSource.indexOf('function updateChartZoomState')
  );
  assert.strictEqual(resetChartZoomSource.includes('const xRange = chartFullXRange;'), true);
  assert.strictEqual(resetChartZoomSource.includes("chartUPlot.setScale('x', { min: xRange.min, max: xRange.max });"), true);
  assert.strictEqual(resetChartZoomSource.includes("chartUPlot.setScale('x', { min: null, max: null });"), false);
  assert.strictEqual(resetChartZoomSource.includes('updateChartZoomState(chartUPlot);'), true);
  assert.strictEqual(resetChartZoomSource.includes('chartZoomed = false;'), false);
  assert.strictEqual(resetChartZoomSource.includes('clearChartSelection();'), true);
  assert.strictEqual(resetChartZoomSource.includes('vscode.postMessage'), false);
  const chartZoomStateSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function updateChartZoomState'),
    resultsPanelSource.indexOf('function queueChartAutoRefine')
  );
  assert.strictEqual(chartZoomStateSource.includes('chartRangeIsZoomed(chartFullXRange, chartXScaleRange(self))'), true);
  assert.strictEqual(chartZoomStateSource.includes('const initial = chartFullXRange;'), true);
  assert.strictEqual(chartZoomStateSource.includes('chartInitialXRange()'), false);
  const chartRequestSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function requestChartDataForRange'),
    resultsPanelSource.indexOf('function exportChartPng')
  );
  assert.strictEqual(chartRequestSource.includes('chartRequestIsRefinement = !!xRange;'), true);
  assert.strictEqual(chartRequestSource.includes('if (!chartRequestIsRefinement) {'), true);
  assert.ok(chartRequestSource.indexOf('if (!chartRequestIsRefinement) {') < chartRequestSource.indexOf('clearChartZoomBaseline();'));
  const drawChartSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function drawChart()'),
    resultsPanelSource.indexOf('function chartDimensions()')
  );
  assert.strictEqual(drawChartSource.includes('if (!chartRequestIsRefinement) {'), true);
  assert.strictEqual(drawChartSource.includes('const renderedXRange = chartXScaleRange(chartUPlot);'), true);
  assert.ok(drawChartSource.indexOf('chartZoomStateSuspended = false;') < drawChartSource.lastIndexOf('updateChartZoomState(chartUPlot);'));
  assert.strictEqual(resultsPanelSource.includes('function formatChartNumber(value)'), true);
  assert.strictEqual(resultsPanelSource.includes('const places = clampInteger(settings.chartDecimalPlaces, 0, 12);'), true);
  assert.strictEqual(resultsPanelSource.includes('normalized.toExponential(places)'), true);
  assert.strictEqual(resultsPanelSource.includes('minimumFractionDigits: places'), true);
  assert.strictEqual(resultsPanelSource.includes('maximumFractionDigits: places'), true);
  assert.strictEqual(resultsPanelSource.includes('function formatChartTemporalValue(value)'), true);
  assert.strictEqual(resultsPanelSource.includes("chartData.xKind === 'temporal'"), true);
  assert.strictEqual(resultsPanelSource.includes('refreshChartFormatting();'), true);
  assert.strictEqual(resultsPanelSource.includes("chartUPlot.root.querySelector('canvas')"), true);
  assert.strictEqual(resultsPanelSource.includes("canvas.toDataURL('image/png')"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'exportChartPng'"), true);
  assert.strictEqual(resultsPanelSource.includes('dataUrl'), true);
  assert.strictEqual(resultsPanelSource.includes('chartRendered = { version: chartData.version, requestId: chartData.requestId };'), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'chartRendered'"), true);
  assert.strictEqual(resultsPanelSource.includes("message.type === 'chartRendered'"), true);
  assert.strictEqual(resultsPanelSource.includes('await this.context.globalState.update(chartSelectionStorageKey(table.columns), compatible);'), true);
  assert.strictEqual(resultsPanelSource.includes('savedSelection: this.savedChartSelection(table, options)'), true);
  assert.strictEqual(resultsPanelSource.includes('chartAutoOpen: this.pendingAutoChart'), true);
  assert.strictEqual(resultsPanelSource.includes('function applySavedChartSelection(value)'), true);
  assert.strictEqual(resultsPanelSource.includes('chartAutoRenderPending = result.chartAutoOpen === true;'), true);
  assert.strictEqual(resultsPanelSource.includes('function queueChartAutoRefine()'), true);
  assert.strictEqual(resultsPanelSource.includes('const CHART_AUTO_REFINE_DELAY_MS = 450;'), true);
  assert.strictEqual(resultsPanelSource.includes('chartLastAutoRefineKey'), true);
  assert.strictEqual(resultsPanelSource.includes('function chartVisibleSamplePointCount(range)'), true);
  assert.strictEqual(resultsPanelSource.includes('function normalizeChartXDomain(value)'), true);
  assert.strictEqual(resultsPanelSource.includes('chartData && chartData.xDomain ? chartData.xDomain'), true);
  const chartAutoRefineThresholdSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function chartAutoRefineMinVisiblePoints()'),
    resultsPanelSource.indexOf('function chartZoomMaxSampledPoints()')
  );
  assert.strictEqual(chartAutoRefineThresholdSource.includes('Math.max(1, chartData.sampledPointCount)'), true);
  assert.strictEqual(chartAutoRefineThresholdSource.includes('Math.min(configuredMinimum, availableSample)'), true);
  assert.strictEqual(resultsPanelSource.includes('message.minSampledPoints = chartZoomMinSampledPoints();'), true);
  assert.strictEqual(resultsPanelSource.includes('message.maxSampledPoints = chartZoomMaxSampledPoints();'), true);
  assert.strictEqual(packageJson.dependencies.uplot, '^1.6.32');
  assert.strictEqual(/cdn\.jsdelivr|unpkg|cdnjs|https:\/\/cdn/i.test(resultsPanelSource), false);
  assert.strictEqual(resultsPanelSource.includes("vscode.postMessage({ type: 'startLocalDataServer' })"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'requestChart'"), true);
  assert.strictEqual(resultsPanelSource.includes('buildChartData(table'), true);
  assert.strictEqual(chartingSource.includes("export type ChartType = 'line' | 'scatter' | 'step' | 'bar' | 'box' | 'candlestick';"), true);
  assert.strictEqual(chartingSource.includes("export type ChartGroupColumnKind = 'categorical';"), true);
  assert.strictEqual(chartingSource.includes('export const CHART_MAX_GROUPS = 12;'), true);
  assert.strictEqual(chartingSource.includes('export function boxStats'), true);
  assert.strictEqual(chartingSource.includes('export function boxChartTargetGroupCount'), true);
  assert.strictEqual(resultsPanelSource.includes('function chartMaxSourceRowsSetting()'), true);
  assert.strictEqual(resultsPanelSource.includes('function chartMaxSourceRowsSettingValue'), true);
  assert.strictEqual(resultsPanelSource.includes('maxSourceRows: chartMaxSourceRowsSetting()'), true);
  assert.strictEqual(/temporarily block the extension host, especially with multiple y columns/.test(chartingSource), true);
  assert.ok(resultsPanelSource.indexOf('id="actionFormat"') < resultsPanelSource.indexOf('id="openChart"'));
  assert.ok(resultsPanelSource.indexOf('id="copy"') < resultsPanelSource.indexOf('id="openChart"'));
  assert.ok(resultsPanelSource.indexOf('id="export"') < resultsPanelSource.indexOf('id="openChart"'));
  assert.strictEqual(resultsPanelSource.includes('id="copyFormat"'), false);
  assert.strictEqual(resultsPanelSource.includes('id="exportFormat"'), false);
  assert.strictEqual(resultsPanelSource.includes("format === 'xlsx'"), true);
  assert.strictEqual(/parquet/i.test([resultsPanelSource, kdbResultsSource, readmeSource, packageSource].join('\n')), false);
  assert.strictEqual(commandTitle('kdb-sqltools.runFile'), 'Run q Script');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrBlock'), 'Run Selection');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrCurrentBlock'), 'Run Selection or q Block');
  assert.ok(packageJson.contributes.menus['editor/title'].some(menu =>
    menu.command === 'kdb-sqltools.runSelectionOrBlock' &&
      menu.when === 'editorLangId == q || resourceExtname == .q'
  ));
  assert.strictEqual(packageJson.contributes.menus['editor/title'].some(menu => menu.command === 'kdb-sqltools.runFile'), false);
  assert.strictEqual(commandTitle('kdb-sqltools.runFileInSqltools'), 'Run q Script in SQLTools Results');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrBlockInSqltools'), 'Run Selection in SQLTools Results');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrCurrentBlockInSqltools'), 'Run Selection or q Block in SQLTools Results');
  assert.strictEqual(commandTitle('kdb-sqltools.runFileInKdbPanel'), 'Run q Script in kdb Panel');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrBlockInKdbPanel'), 'Run Selection in kdb Panel');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrCurrentBlockInKdbPanel'), 'Run Selection or q Block in kdb Panel');
  assert.strictEqual(commandTitle('kdb-sqltools.runFileInKdbPanelReplace'), 'Run q Script in kdb Panel (Replace)');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrBlockInKdbPanelReplace'), 'Run Selection in kdb Panel (Replace)');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrCurrentBlockInKdbPanelReplace'), 'Run Selection or q Block in kdb Panel (Replace)');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrBlockAndChart'), 'Run Selection and Chart');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrCurrentBlockAndChart'), 'Run Selection or q Block and Chart');
  assert.strictEqual(commandTitle('kdb-sqltools.runFileInNewKdbPanel'), 'Run q Script in New kdb Panel');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrBlockInNewKdbPanel'), 'Run Selection in New kdb Panel');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrCurrentBlockInNewKdbPanel'), 'Run Selection or q Block in New kdb Panel');
  assert.strictEqual(commandTitle('kdb-sqltools.openKeyboardShortcuts'), 'Open kdb Keyboard Shortcuts');
  assert.strictEqual(commandTitle('kdb-sqltools.copyKdbPanelSelection'), 'Copy');
  assert.strictEqual(commandTitle('kdb-sqltools.openLocalDataServer'), 'Start Local Data Server');
  assert.strictEqual(commandTitle('kdb-sqltools.stopLocalDataServer'), 'Stop Local Data Server');
  assert.strictEqual(commandTitle('kdb-sqltools.copyLocalDataServerUrl'), 'Copy Local Data Server current.csv URL');
  assert.strictEqual(commandTitle('kdb-sqltools.reportBug'), 'Report Bug');
  assert.strictEqual(commandTitle('kdb-sqltools.requestFeature'), 'Request Feature');
  assert.strictEqual(commandTitle('kdb-sqltools.giveFeedback'), 'Give Feedback');
  const qCtrlEnterWhen = 'editorTextFocus && (editorLangId == q || resourceExtname == .q)';
  const qCtrlEnterBindingIndex = packageJson.contributes.keybindings.findIndex(binding =>
    binding.command === 'kdb-sqltools.runSelectionOrBlockInKdbPanelReplace'
  );
  assert.deepStrictEqual(
    packageJson.contributes.keybindings.slice(qCtrlEnterBindingIndex - 2, qCtrlEnterBindingIndex),
    [
      { command: '-sqltools.executeQuery', key: 'ctrl+enter', mac: 'cmd+enter', when: qCtrlEnterWhen },
      { command: '-sqltools.executeCurrentQuery', key: 'ctrl+enter', mac: 'cmd+enter', when: qCtrlEnterWhen },
    ]
  );
  assert.deepStrictEqual(packageJson.contributes.keybindings[qCtrlEnterBindingIndex], {
    command: 'kdb-sqltools.runSelectionOrBlockInKdbPanelReplace',
    key: 'ctrl+enter',
    mac: 'cmd+enter',
    when: qCtrlEnterWhen,
  });
  assert.strictEqual(keybinding('kdb-sqltools.runSelectionOrBlockInKdbPanelReplace').key, 'ctrl+enter');
  assert.strictEqual(keybinding('kdb-sqltools.runSelectionOrBlockInKdbPanelReplace').mac, 'cmd+enter');
  assert.strictEqual(keybinding('kdb-sqltools.runSelectionOrBlockInNewKdbPanel').key, 'ctrl+shift+enter');
  assert.strictEqual(keybinding('kdb-sqltools.runSelectionOrBlockInNewKdbPanel').mac, 'cmd+shift+enter');
  assert.strictEqual(keybinding('kdb-sqltools.runFileInKdbPanelReplace').key, 'ctrl+alt+enter');
  assert.strictEqual(keybinding('kdb-sqltools.runSelectionOrBlockAndChart').key, 'ctrl+alt+c');
  assert.strictEqual(keybinding('kdb-sqltools.runSelectionOrBlockAndChart').mac, 'cmd+alt+c');
  assert.strictEqual(keybinding('kdb-sqltools.runSelectionOrCurrentBlockInKdbPanelReplace'), undefined);
  assert.strictEqual(keybinding('kdb-sqltools.runSelectionOrCurrentBlockAndChart'), undefined);
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.runSelectionOrBlockInNewKdbPanel'));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.runSelectionOrBlockInKdbPanelReplace'));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.runSelectionOrBlockAndChart'));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.runSelectionOrCurrentBlock'));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.runSelectionOrCurrentBlockInSqltools'));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.runSelectionOrCurrentBlockInKdbPanel'));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.runSelectionOrCurrentBlockInKdbPanelReplace'));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.runSelectionOrCurrentBlockAndChart'));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.runSelectionOrCurrentBlockInNewKdbPanel'));
  assert.ok(packageJson.contributes.menus.commandPalette.some(menu =>
    menu.command === 'kdb-sqltools.runSelectionOrCurrentBlock' &&
      menu.when === 'editorLangId == q || resourceExtname == .q'
  ));
  assert.ok(packageJson.contributes.menus.commandPalette.some(menu =>
    menu.command === 'kdb-sqltools.runSelectionOrCurrentBlockAndChart' &&
      menu.when === 'editorLangId == q || resourceExtname == .q'
  ));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.copyKdbPanelSelection'));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.openLocalDataServer'));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.stopLocalDataServer'));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.copyLocalDataServerUrl'));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.reportBug'));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.requestFeature'));
  assert.ok(packageJson.activationEvents.includes('onCommand:kdb-sqltools.giveFeedback'));
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.runSelectionOrBlockInNewKdbPanel'"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.runSelectionOrBlockInKdbPanelReplace'"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.runSelectionOrBlockAndChart'"), true);
  assert.strictEqual(extensionSource.includes('runQSelectionOrLine'), true);
  assert.strictEqual(extensionSource.includes('selectedTextOrCurrentLine'), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.runSelectionOrBlock', () => runQSelectionOrLine(extContext)"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.runSelectionOrBlockInSqltools', () => runQSelectionOrLine(extContext, 'sqltools')"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.runSelectionOrBlockInKdbPanel', () => runQSelectionOrLine(extContext, 'kdbPanel')"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.runSelectionOrBlockInKdbPanelReplace', () => runQSelectionOrLine(extContext, 'kdbPanel', 'replace')"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.runSelectionOrBlockInNewKdbPanel', () => runQSelectionOrLine(extContext, 'kdbPanel', 'new')"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.runSelectionOrCurrentBlock', () => runQSelectionOrBlock(extContext)"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.runSelectionOrCurrentBlockInSqltools', () => runQSelectionOrBlock(extContext, 'sqltools')"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.runSelectionOrCurrentBlockInKdbPanel', () => runQSelectionOrBlock(extContext, 'kdbPanel')"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.runSelectionOrCurrentBlockInKdbPanelReplace', () => runQSelectionOrBlock(extContext, 'kdbPanel', 'replace')"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.runSelectionOrCurrentBlockInNewKdbPanel', () => runQSelectionOrBlock(extContext, 'kdbPanel', 'new')"), true);
  const runSelectionOrLineSource = extensionSource.slice(
    extensionSource.indexOf('async function runQSelectionOrLine'),
    extensionSource.indexOf('async function runQSelectionOrBlock')
  );
  assert.strictEqual(runSelectionOrLineSource.includes('selectedTextOrCurrentLine(editor.document.getText(), selectionText, editor.selection.active.line)'), true);
  assert.strictEqual(runSelectionOrLineSource.includes('selectedTextOrCurrentBlock'), false);
  const runSelectionOrBlockSource = extensionSource.slice(
    extensionSource.indexOf('async function runQSelectionOrBlock'),
    extensionSource.indexOf('async function runQSelectionOrLineAndChart')
  );
  assert.strictEqual(runSelectionOrBlockSource.includes('selectedTextOrCurrentBlock(editor.document.getText(), selectionText, editor.selection.active.line)'), true);
  assert.strictEqual(runSelectionOrBlockSource.includes('selectedTextOrCurrentLine'), false);
  assert.strictEqual(runSelectionOrBlockSource.includes('autoChart'), false);
  const runSelectionOrLineAndChartSource = extensionSource.slice(
    extensionSource.indexOf('async function runQSelectionOrLineAndChart'),
    extensionSource.indexOf('async function runQSelectionOrBlockAndChart')
  );
  assert.strictEqual(runSelectionOrLineAndChartSource.includes('selectedTextOrCurrentLine(editor.document.getText(), selectionText, editor.selection.active.line)'), true);
  assert.strictEqual(runSelectionOrLineAndChartSource.includes('{ autoChart: true }'), true);
  const runSelectionOrBlockAndChartSource = extensionSource.slice(
    extensionSource.indexOf('async function runQSelectionOrBlockAndChart'),
    extensionSource.indexOf('async function executeQText')
  );
  assert.strictEqual(runSelectionOrBlockAndChartSource.includes('selectedTextOrCurrentBlock(editor.document.getText(), selectionText, editor.selection.active.line)'), true);
  assert.strictEqual(runSelectionOrBlockAndChartSource.includes('{ autoChart: true }'), true);
  assert.strictEqual(sourceOccurrences(extensionSource, '{ autoChart: true }'), 2);
  assert.strictEqual(extensionSource.includes("await executeQText(extContext, text, 'kdbPanel', 'replace', { autoChart: true });"), true);
  assert.strictEqual(extensionSource.includes('{ autoChart: options.autoChart === true }'), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.copyKdbPanelSelection'"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.openLocalDataServer'"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.stopLocalDataServer'"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.copyLocalDataServerUrl'"), true);
  assert.strictEqual(extensionSource.includes('KdbResultsPanel.stopAllLocalDataServers();'), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.reportBug'"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.requestFeature'"), true);
  assert.strictEqual(extensionSource.includes("'kdb-sqltools.giveFeedback'"), true);
  assert.strictEqual(extensionSource.includes('vscode.env.openExternal(vscode.Uri.parse(githubIssueUrl(feedbackIssueTemplate(kind))))'), true);
  assert.strictEqual(extensionSource.includes('GITHUB_ISSUES_NEW_URL'), true);
  assert.strictEqual(readmeSource.includes('VS Code settings cannot host extension buttons'), true);
  assert.strictEqual(readmeSource.includes('[Bug report][bug-report]'), true);
  assert.strictEqual(readmeSource.includes('[Feature request][feature-request]'), true);
  assert.strictEqual(readmeSource.includes('[General feedback][general-feedback]'), true);
  assert.ok(packageJson.contributes.menus['webview/context'].some(menu =>
    menu.command === 'kdb-sqltools.copyKdbPanelSelection' &&
      menu.when === "webviewId == 'kdbSqltoolsResults' && webviewSection == 'kdbResultsTable'"
  ));
  assert.strictEqual(extensionSource.includes('configuredKdbPanelRunMode()'), true);
  assert.strictEqual(extensionSource.includes("get<string>(KDB_PANEL_DEFAULT_RUN_MODE_SETTING, 'new')"), true);
  assert.strictEqual(extensionSource.includes("workbench.action.openGlobalKeybindings"), true);
  assert.strictEqual(resultsPanelSource.includes('private static panels: KdbResultsPanel[] = [];'), true);
  assert.strictEqual(resultsPanelSource.includes('private static lastActivePanel'), true);
  assert.strictEqual(resultsPanelSource.includes('private readonly disposables: vscode.Disposable[] = [];'), true);
  assert.strictEqual(resultsPanelSource.includes('this.panel.onDidDispose(() => this.disposePanel(), undefined, this.disposables)'), true);
  assert.strictEqual(resultsPanelSource.includes('this.context.subscriptions'), false);
  assert.strictEqual(resultsPanelSource.includes("return KdbResultsPanel.showResult(this.context, result, 'replace');"), false);
  assert.strictEqual(resultsPanelSource.includes('private disposePanel(): void'), true);
  assert.strictEqual(resultsPanelSource.includes('this.result = undefined;'), true);
  assert.strictEqual(resultsPanelSource.includes('this.loading = undefined;'), true);
  assert.strictEqual(resultsPanelSource.includes('this.disposables.splice(0).forEach(disposable => disposable.dispose())'), true);
  assert.strictEqual(resultsPanelSource.includes('this.panel.reveal(this.panel.viewColumn, true);'), true);
  assert.strictEqual(resultsPanelSource.includes('this.panel.reveal();'), false);
  assert.strictEqual(resultsPanelSource.includes('this.panel.reveal(vscode.ViewColumn.Beside)'), false);
  assert.strictEqual(resultsPanelSource.includes('{ viewColumn, preserveFocus: true }'), true);
  assert.strictEqual(resultsPanelSource.includes('initialResultViewColumn()'), true);
  assert.strictEqual(resultsPanelSource.includes('panelTitle(panelNumber)'), true);
  const ensurePanelSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('private static ensure'),
    resultsPanelSource.indexOf('private static newPanelViewColumn')
  );
  assert.strictEqual(ensurePanelSource.includes("if (mode === 'new')"), true);
  assert.strictEqual(ensurePanelSource.includes('KdbResultsPanel.newPanelViewColumn()'), true);
  assert.strictEqual(ensurePanelSource.includes('new KdbResultsPanel(context, initialResultViewColumn())'), false);
  const newPanelViewColumnSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('private static newPanelViewColumn'),
    resultsPanelSource.indexOf('private static reusablePanel')
  );
  assert.strictEqual(newPanelViewColumnSource.includes('const anchor = KdbResultsPanel.reusablePanel();'), true);
  assert.strictEqual(newPanelViewColumnSource.includes('anchor.panel.viewColumn !== undefined'), true);
  assert.strictEqual(newPanelViewColumnSource.includes('anchor.panel.viewColumn'), true);
  assert.ok(
    newPanelViewColumnSource.indexOf('anchor.panel.viewColumn') <
      newPanelViewColumnSource.indexOf('initialResultViewColumn()'),
    'new panels should prefer an existing results panel viewColumn before initial placement'
  );
  const resultsPanelConstructorSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('private constructor'),
    resultsPanelSource.indexOf('private disposePanel')
  );
  assert.strictEqual(resultsPanelConstructorSource.includes('viewColumn: vscode.ViewColumn = initialResultViewColumn()'), true);
  assert.strictEqual(resultsPanelConstructorSource.includes('panelTitle(panelNumber),\n      { viewColumn, preserveFocus: true },'), true);
  assert.strictEqual(/function textExportFormat[\s\S]*return 'csv';/.test(resultsPanelSource), true);
  assert.strictEqual(/function exportFormat[\s\S]*return 'csv';/.test(resultsPanelSource), true);
  assert.strictEqual(resultsPanelSource.includes("case 'markdown':"), true);
  assert.strictEqual(resultsPanelSource.includes("return { Markdown: ['md', 'markdown'] };"), true);
  assert.strictEqual(resultsPanelSource.includes("const extension = format === 'markdown' ? 'md' : format;"), true);
  assert.strictEqual(kdbResultsSource.includes('export function rowsToMarkdown'), true);
  assert.strictEqual(kdbResultsSource.includes('function columnarToMarkdown'), true);
  assert.strictEqual(kdbResultsSource.includes('escapeMarkdownTableCell'), true);
  assert.strictEqual(resultsPanelSource.includes('sheetXml(result, range, includeHeaders, includeRowIndex, cellTextOptions)'), true);
  assert.strictEqual(resultsPanelSource.includes('headers.push(cellValueToText(rowIndexColumnName(result.columns, range)))'), true);
  assert.strictEqual(resultsPanelSource.includes('LARGE_RESULT_WARNING_CELL_THRESHOLD'), true);
  assert.strictEqual(resultsPanelSource.includes('resultSizeGuardrailMessage(result.table.rowCount, result.table.columns.length)'), true);
  assert.strictEqual(resultsPanelSource.includes('COPY_EXPORT_CONFIRM_CELL_THRESHOLD'), true);
  assert.strictEqual(resultsPanelSource.includes('largeCopyExportConfirmationMessage'), true);
  assert.strictEqual(resultsPanelSource.includes("showWarningMessage(message, 'Continue', 'Cancel')"), true);
  assert.strictEqual(resultsPanelSource.includes('validateXlsxSheetLimits(clamped, { includeHeaders, includeRowIndex })'), true);
  assert.strictEqual(resultsPanelSource.includes('id="largeResultWarning"'), true);
  assert.strictEqual(resultsPanelSource.includes('function updateLargeResultWarning()'), true);
  assert.strictEqual(resultsPanelSource.includes("message.type === 'hideLargeResultWarningOnce'"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'hideLargeResultWarningOnce'"), true);
  assert.strictEqual(resultsPanelSource.includes('private hideLargeResultWarningOnce = false;'), true);
  assert.strictEqual(resultsPanelSource.includes('parts.push(value.guardrailMessage)'), false);
  assert.strictEqual(resultsPanelSource.includes("className = 'message-actions'"), false);
  assert.strictEqual(resultsPanelSource.includes("return value.error || value.canceled ? value.messages.slice().join('\\\\n') : '';"), true);
  assert.strictEqual(resultsPanelSource.includes('function formatElapsedMs(milliseconds, display)'), true);
  assert.strictEqual(resultsPanelSource.includes("display === 'milliseconds'"), true);
  assert.strictEqual(resultsPanelSource.includes("formatElapsedMs(data.elapsedMs, settings.elapsedTimeDisplay)"), true);
  assert.strictEqual(resultsPanelSource.includes("Sort and Don't Warn Again"), true);
  assert.strictEqual(resultsPanelSource.includes("'hideLargeSortWarnings'"), true);
  assert.strictEqual(resultsPanelSource.includes("return 'Selected: 1 cell';"), true);
  assert.strictEqual(resultsPanelSource.includes("return 'Range '"), false);
  assert.strictEqual(kdbResultsSource.includes('XLSX_MAX_ROWS = 1048576'), true);
  assert.strictEqual(kdbResultsSource.includes('XLSX_MAX_COLUMNS = 16384'), true);
  assert.strictEqual(extensionSource.includes('driver.query(text, {})'), false, 'kdbPanel execution must not use row-object SQLTools driver.query');
  assert.strictEqual(extensionSource.includes('client.query(text)'), false, 'kdbPanel execution should use shared raw driver query handling');
  assert.strictEqual(extensionSource.includes('return await driver.rawQuery(text);'), true, 'kdbPanel execution should use shared raw driver query handling');
  assert.strictEqual(extensionSource.includes('parseBeforeSaveConnection: (arg: any = {}) => normalizeConnection(arg && arg.connInfo)'), true);
  assert.strictEqual(extensionSource.includes('parseBeforeEditConnection: (arg: any = {}) => normalizeConnection(arg && arg.connInfo)'), true);
  assert.strictEqual(extensionSource.includes('export function isKdbConnection(connection?: Partial<IConnection<any>> | null): boolean'), true);
  assert.strictEqual(extensionSource.includes('export function normalizeConnection(connection?: Partial<IConnection<any>> | null): IConnection<any>'), true);
  assert.strictEqual(extensionSource.includes("driver: DRIVER_ID"), true);
  assert.strictEqual(extensionSource.includes("server: safeConnection.server || 'localhost'"), true);
  assert.strictEqual(extensionSource.includes("port: safeConnection.port || 5000"), true);
  assert.strictEqual(extensionSource.includes("database: safeConnection.database || '.'"), true);
  const kdbPanelRunSource = extensionSource.slice(
    extensionSource.indexOf('async function executeQTextInKdbPanel'),
    extensionSource.indexOf('async function pickKdbConnection')
  );
  assert.strictEqual(kdbPanelRunSource.includes('cancellable: true'), true);
  assert.strictEqual(kdbPanelRunSource.includes('cancellable: false'), false);
  assert.strictEqual(kdbPanelRunSource.includes('const cancelRun = () => {'), true);
  assert.strictEqual(kdbPanelRunSource.includes('driver.cancel(cancellationError);'), true);
  assert.strictEqual(kdbPanelRunSource.includes('panel.setLoadingCancelHandler(runVersion, cancelRun)'), true);
  assert.strictEqual(kdbPanelRunSource.includes('token.onCancellationRequested(cancelRun)'), true);
  assert.strictEqual(kdbPanelRunSource.includes('panel.isLoadingVersion(runVersion)'), true);
  assert.strictEqual(kdbPanelRunSource.includes('canceled: true'), true);
  assert.ok(
    kdbPanelRunSource.indexOf('if (cancelRequested || error === cancellationError)') <
      kdbPanelRunSource.indexOf("vscode.window.showErrorMessage(failureMessages.join(' '))"),
    'expected user cancellation should return before error toast'
  );
  assert.strictEqual(kdbPanelRunSource.includes('const failureMessages = kdbPanelFailureMessages(err, connection, text);'), true);
  assert.strictEqual(extensionSource.includes('function kdbPanelFailureMessages(error: Error, connection: IConnection<any>, text: string): string[]'), true);
  assert.strictEqual(extensionSource.includes('`q failed on ${connectionLabel(connection)}.`'), true);
  assert.strictEqual(extensionSource.includes('`Query: ${qTextPreview(text)}`'), true);
  assert.strictEqual(extensionSource.includes('function connectionLabel(connection: Partial<IConnection<any>>): string'), true);
  assert.strictEqual(extensionSource.includes('function qTextPreview(text: string, maxChars = 240): string'), true);
  assert.strictEqual(qIpcSource.includes('private connectingSocket: net.Socket | null = null;'), true);
  assert.strictEqual(qIpcSource.includes('private pendingConnect: PendingConnect | null = null;'), true);
  assert.strictEqual(qIpcSource.includes('private connectPromise: Promise<void> | null = null;'), true);
  assert.strictEqual(qIpcSource.includes("public cancel(error: Error = new KdbIpcError('kdb+ query canceled')): void"), true);
  assert.strictEqual(qIpcSource.includes('this.failAll(error);'), true);
  assert.strictEqual(qIpcSource.includes('this.rejectConnecting(error);'), true);
  assert.strictEqual(qIpcSource.includes("private phaseError(phase: KdbIpcPhase, error: Error): KdbIpcError"), true);
  assert.strictEqual(qIpcSource.includes('socket.destroy(error);'), true);
  assert.strictEqual(qIpcSource.includes('connectingSocket.destroy(error);'), true);
  assert.strictEqual(driverSource.includes("public cancel(error: Error = new KdbIpcError('kdb+ query canceled')): void"), true);
  assert.strictEqual(driverSource.includes('this.openingClient.cancel(error);'), true);
  assert.strictEqual(driverSource.includes('client => client.cancel(error)'), true);
  assert.strictEqual(driverSource.includes('public async rawQuery(query: string): Promise<QValue>'), true);
  assert.strictEqual(driverSource.includes('export function queryInNamespace(query: string, namespace?: string): string'), true);
  assert.strictEqual(readmeSource.includes('Cancellable kdb results panel runs'), true);
  assert.strictEqual(runningDocsSource.includes('## Canceling a run'), true);
  assert.strictEqual(resultsDocsSource.includes('## Cancel running queries'), true);
  assert.strictEqual(runningDocsSource.includes("panel's `Cancel` button"), true);
  assert.strictEqual(resultsDocsSource.includes('short `Cancel` button'), true);
  assert.strictEqual(troubleshootingDocsSource.includes('click `Cancel`'), true);
  assert.strictEqual(/best-effort/i.test(readmeSource + runningDocsSource + resultsDocsSource + troubleshootingDocsSource), true);
  const resultSettings = packageJson.contributes.configuration.properties;
  assert.strictEqual(resultSettings['kdb-sqltools.results.target'].default, 'kdbPanel');
  assert.strictEqual(resultSettings['kdb-sqltools.results.kdbPanel.defaultRunMode'].default, 'new');
  assert.deepStrictEqual(resultSettings['kdb-sqltools.results.kdbPanel.defaultRunMode'].enum, ['replace', 'new']);
  assert.strictEqual(resultSettings['kdb-sqltools.results.kdbPanel.initialViewColumn'].default, 'active');
  assert.deepStrictEqual(resultSettings['kdb-sqltools.results.kdbPanel.initialViewColumn'].enum, ['active', 'beside', 'one', 'two', 'three']);
  assert.strictEqual(resultSettings['kdb-sqltools.results.kdbPanel.arrayDisplayFormat'].type, 'string');
  assert.strictEqual(resultSettings['kdb-sqltools.results.kdbPanel.arrayDisplayFormat'].default, 'commaSpace');
  assert.deepStrictEqual(resultSettings['kdb-sqltools.results.kdbPanel.arrayDisplayFormat'].enum, ['commaSpace', 'space', 'raw']);
  const qDisplayStrategyEnum = ['grid', 'qText', 'table', 'text'];
  const qDisplayStrategySettings = [
    ['functionDisplayStrategy', 'qText'],
    ['dictionaryDisplayStrategy', 'grid'],
    ['listDisplayStrategy', 'grid'],
    ['objectDisplayStrategy', 'grid'],
  ];
  qDisplayStrategySettings.forEach(([name, defaultValue]) => {
    const setting = resultSettings[`kdb-sqltools.results.kdbPanel.${name}`];
    assert.strictEqual(setting.type, 'string');
    assert.strictEqual(setting.default, defaultValue);
    assert.deepStrictEqual(setting.enum, qDisplayStrategyEnum);
    assert.ok(/Display strategy/.test(setting.description));
    assert.strictEqual(/cell|grid|column|synthetic/i.test(setting.enumDescriptions[1]), false);
  });
  assert.ok(/source-unavailable marker/.test(resultSettings['kdb-sqltools.results.kdbPanel.functionDisplayStrategy'].description));
  assert.ok(/Return string f or \.Q\.s f/.test(resultSettings['kdb-sqltools.results.kdbPanel.functionDisplayStrategy'].description));
  const qTextDocsLines = [resultsDocsSource, settingsDocsSource]
    .join('\n')
    .split('\n')
    .filter(line => line.includes('qText'))
    .join('\n');
  assert.strictEqual(/single text cell|one text cell|single cell|one-cell grid|synthetic .*cell/i.test(qTextDocsLines), false);
  assert.strictEqual(/single text cell|one text cell|single cell|one-cell grid|Show q-like\/default text in a single cell/i.test(packageSource), false);
  const qTextPanelResultSource = qIpcSource.slice(
    qIpcSource.indexOf('function qTextPanelResult'),
    qIpcSource.indexOf('function qTextValue')
  );
  assert.strictEqual(qTextPanelResultSource.includes("mode: 'text'"), true);
  assert.strictEqual(qTextPanelResultSource.includes('createColumnarPanelResult'), false);
  assert.strictEqual(resultsPanelSource.includes('<pre id="textViewer" class="text-viewer"></pre>'), true);
  assert.strictEqual(resultsPanelSource.includes('function renderTextResult()'), true);
  assert.strictEqual(resultsPanelSource.includes("if (isTextResult()) {\n          renderTextResult();"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'copyText'"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'exportText'"), true);
  assert.strictEqual(resultsPanelSource.includes('white-space: pre-wrap;'), true);
  assert.strictEqual(extensionSource.includes("mode: 'text'"), true);
  const chartMaxSourceRowsSetting = resultSettings['kdb-sqltools.results.kdbPanel.chartMaxSourceRows'];
  assert.strictEqual(chartMaxSourceRowsSetting.type, 'integer');
  assert.strictEqual(chartMaxSourceRowsSetting.default, CHART_MAX_SOURCE_ROWS);
  assert.strictEqual(chartMaxSourceRowsSetting.minimum, 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(chartMaxSourceRowsSetting, 'maximum'), false);
  assert.strictEqual(/no hard upper bound/i.test(chartMaxSourceRowsSetting.description), true);
  assert.strictEqual(/temporarily block the extension host/i.test(chartMaxSourceRowsSetting.description), true);
  const chartDecimalPlacesSetting = resultSettings['kdb-sqltools.results.kdbPanel.chartDecimalPlaces'];
  assert.strictEqual(chartDecimalPlacesSetting.type, 'integer');
  assert.strictEqual(chartDecimalPlacesSetting.default, 4);
  assert.strictEqual(chartDecimalPlacesSetting.minimum, 0);
  assert.strictEqual(chartDecimalPlacesSetting.maximum, 12);
  assert.strictEqual(/axis ticks, tooltips, legend\/live values, and box statistics/i.test(chartDecimalPlacesSetting.description), true);
  const chartZoomMinSetting = resultSettings['kdb-sqltools.results.kdbPanel.chartZoomMinSampledPoints'];
  assert.strictEqual(chartZoomMinSetting.type, 'integer');
  assert.strictEqual(chartZoomMinSetting.default, CHART_ZOOM_MIN_SAMPLED_POINTS);
  assert.strictEqual(chartZoomMinSetting.minimum, 1);
  assert.strictEqual(/auto-refines a settled zoom range/i.test(chartZoomMinSetting.description), true);
  const chartZoomMaxSetting = resultSettings['kdb-sqltools.results.kdbPanel.chartZoomMaxSampledPoints'];
  assert.strictEqual(chartZoomMaxSetting.type, 'integer');
  assert.strictEqual(chartZoomMaxSetting.default, CHART_ZOOM_MAX_SAMPLED_POINTS);
  assert.strictEqual(chartZoomMaxSetting.minimum, 1);
  assert.strictEqual(/clamped up to that minimum/i.test(chartZoomMaxSetting.description), true);
  assert.strictEqual(resultSettings['kdb-sqltools.performance.trace'].type, 'boolean');
  assert.strictEqual(resultSettings['kdb-sqltools.performance.trace'].default, false);
  assert.strictEqual(/extension host console/i.test(resultSettings['kdb-sqltools.performance.trace'].description), true);
  assert.deepStrictEqual(resultSettings['kdb-sqltools.results.density'].enum, ['compact', 'standard', 'comfortable']);
  assert.ok(/Switching density loads that density's saved cell width, row height, and font size/.test(
    resultSettings['kdb-sqltools.results.density'].description
  ));
  assert.ok(/Legacy fallback cell width/.test(resultSettings['kdb-sqltools.results.cellWidth'].description));
  assert.deepStrictEqual(
    ['compact', 'standard', 'comfortable'].map(density => [
      resultSettings[`kdb-sqltools.results.${density}.cellWidth`].default,
      resultSettings[`kdb-sqltools.results.${density}.rowHeight`].default,
      resultSettings[`kdb-sqltools.results.${density}.fontSize`].default,
    ]),
    [[140, 24, 0], [160, 28, 0], [180, 32, 0]]
  );
  assert.strictEqual(resultSettings['kdb-sqltools.results.showRowIndex'].type, 'boolean');
  assert.strictEqual(resultSettings['kdb-sqltools.results.showRowIndex'].default, true);
  assert.strictEqual(resultSettings['kdb-sqltools.results.includeHeaders'].type, 'boolean');
  assert.strictEqual(resultSettings['kdb-sqltools.results.includeHeaders'].default, true);
  assert.strictEqual(resultSettings['kdb-sqltools.results.includeRowIndex'].type, 'boolean');
  assert.strictEqual(resultSettings['kdb-sqltools.results.includeRowIndex'].default, true);
  assert.strictEqual(resultSettings['kdb-sqltools.results.hideLargeResultWarnings'].type, 'boolean');
  assert.strictEqual(resultSettings['kdb-sqltools.results.hideLargeResultWarnings'].default, false);
  assert.strictEqual(resultSettings['kdb-sqltools.results.hideLargeSortWarnings'].type, 'boolean');
  assert.strictEqual(resultSettings['kdb-sqltools.results.hideLargeSortWarnings'].default, false);
  assert.strictEqual(resultSettings['kdb-sqltools.results.elapsedTimeDisplay'].type, 'string');
  assert.strictEqual(resultSettings['kdb-sqltools.results.elapsedTimeDisplay'].default, 'auto');
  assert.deepStrictEqual(resultSettings['kdb-sqltools.results.elapsedTimeDisplay'].enum, ['auto', 'milliseconds']);
  assert.strictEqual(resultsPanelSource.includes('settingsHideLargeResultWarnings'), true);
  assert.strictEqual(resultsPanelSource.includes('settingsHideLargeSortWarnings'), true);
  assert.strictEqual(resultsPanelSource.includes('settingsChartDecimalPlaces'), true);
  assert.strictEqual(resultsPanelSource.includes('settingsElapsedTimeDisplay'), true);
  assert.strictEqual(resultsPanelSource.includes('settingsArrayDisplayFormat'), true);
  assert.strictEqual(resultsPanelSource.includes('settingsFunctionDisplayStrategy'), true);
  assert.strictEqual(resultsPanelSource.includes('settingsDictionaryDisplayStrategy'), true);
  assert.strictEqual(resultsPanelSource.includes('settingsListDisplayStrategy'), true);
  assert.strictEqual(resultsPanelSource.includes('settingsObjectDisplayStrategy'), true);
  assert.deepStrictEqual(htmlSelectOptions(resultsPanelSource, 'settingsArrayDisplayFormat'), ['commaSpace', 'space', 'raw']);
  assert.deepStrictEqual(htmlSelectOptions(resultsPanelSource, 'settingsFunctionDisplayStrategy'), ['grid', 'qText']);
  assert.deepStrictEqual(htmlSelectOptions(resultsPanelSource, 'settingsDictionaryDisplayStrategy'), ['grid', 'qText']);
  assert.deepStrictEqual(htmlSelectOptions(resultsPanelSource, 'settingsListDisplayStrategy'), ['grid', 'qText']);
  assert.deepStrictEqual(htmlSelectOptions(resultsPanelSource, 'settingsObjectDisplayStrategy'), ['grid', 'qText']);
  assert.strictEqual(extensionSource.includes('qValueToColumnarPanel(value, qResultDisplayOptions())'), true);
  assert.strictEqual(extensionSource.includes("config.get<string>('functionDisplayStrategy')"), true);
  assert.strictEqual(resultsPanelSource.includes('Hide forever'), true);
  assert.deepStrictEqual(
    [
      resultSettings['kdb-sqltools.results.cellWidth'].default,
      resultSettings['kdb-sqltools.results.cellWidth'].minimum,
      resultSettings['kdb-sqltools.results.cellWidth'].maximum,
      resultSettings['kdb-sqltools.results.rowHeight'].default,
      resultSettings['kdb-sqltools.results.rowHeight'].minimum,
      resultSettings['kdb-sqltools.results.rowHeight'].maximum,
      resultSettings['kdb-sqltools.results.fontSize'].default,
      resultSettings['kdb-sqltools.results.fontSize'].minimum,
      resultSettings['kdb-sqltools.results.fontSize'].maximum,
    ],
    [160, 80, 600, 28, 20, 80, 0, 0, 32]
  );
  assert.strictEqual(resultsPanelSource.includes('RESULT_SETTING_UPDATE_ALLOWLIST'), true);
  assert.strictEqual(resultsPanelSource.includes("message.type === 'updateSetting'"), true);
  assert.strictEqual(resultsPanelSource.includes('const settingKey = panelSettingConfigKey('), true);
  assert.strictEqual(resultsPanelSource.includes("`${density}.${key}`"), true);
  assert.strictEqual(resultsPanelSource.includes('DEFAULT_DENSITY_SIZE_SETTINGS'), true);
  assert.strictEqual(resultsPanelSource.includes('function panelSizeSettingValue'), true);
  assert.strictEqual(resultsPanelSource.includes('vscode.ConfigurationTarget.Global'), true);
  const numberSettingUpdateSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function numberSettingUpdate'),
    resultsPanelSource.indexOf('function densitySettingUpdate')
  );
  assert.strictEqual(numberSettingUpdateSource.includes('Math.min(Math.max(Math.floor(number), min), max)'), true);
  assert.strictEqual(numberSettingUpdateSource.includes('integer >= min && integer <= max'), false);
  assert.strictEqual(resultsPanelSource.includes('Object.prototype.hasOwnProperty.call(RESULT_SETTING_UPDATE_ALLOWLIST, key)'), true);
  const resultsPanelInternals = loadResultsPanelInternals();
  assert.strictEqual(resultsPanelInternals.chartMaxSourceRowsSettingValue(undefined), CHART_MAX_SOURCE_ROWS);
  assert.strictEqual(resultsPanelInternals.chartMaxSourceRowsSettingValue('abc'), CHART_MAX_SOURCE_ROWS);
  assert.strictEqual(resultsPanelInternals.chartMaxSourceRowsSettingValue(Infinity), CHART_MAX_SOURCE_ROWS);
  assert.strictEqual(resultsPanelInternals.chartMaxSourceRowsSettingValue(0), CHART_MAX_SOURCE_ROWS);
  assert.strictEqual(resultsPanelInternals.chartMaxSourceRowsSettingValue(1.9), 1);
  assert.strictEqual(resultsPanelInternals.chartMaxSourceRowsSettingValue(1000000000000), 1000000000000);
  assert.strictEqual(resultsPanelInternals.chartDecimalPlacesSettingValue(undefined), 4);
  assert.strictEqual(resultsPanelInternals.chartDecimalPlacesSettingValue('abc'), 4);
  assert.strictEqual(resultsPanelInternals.chartDecimalPlacesSettingValue(-1), 0);
  assert.strictEqual(resultsPanelInternals.chartDecimalPlacesSettingValue(3.9), 3);
  assert.strictEqual(resultsPanelInternals.chartDecimalPlacesSettingValue(13), 12);
  assert.strictEqual(resultsPanelInternals.chartZoomMinSampledPointsSettingValue(undefined), CHART_ZOOM_MIN_SAMPLED_POINTS);
  assert.strictEqual(resultsPanelInternals.chartZoomMinSampledPointsSettingValue(0), CHART_ZOOM_MIN_SAMPLED_POINTS);
  assert.strictEqual(resultsPanelInternals.chartZoomMinSampledPointsSettingValue(12.9), 12);
  assert.strictEqual(resultsPanelInternals.chartZoomMaxSampledPointsSettingValue(undefined, 8000), 8000);
  assert.strictEqual(resultsPanelInternals.chartZoomMaxSampledPointsSettingValue(10, 12), 12);
  assert.strictEqual(resultsPanelInternals.chartZoomMaxSampledPointsSettingValue(50.9, 12), 50);
  assert.strictEqual(resultsPanelInternals.chartRangeIsZoomed({ min: 0, max: 100 }, { min: 0, max: 100 }), false);
  assert.strictEqual(resultsPanelInternals.chartRangeIsZoomed({ min: 0, max: 100 }, { min: 1e-8, max: 100 - 1e-8 }), false);
  assert.strictEqual(resultsPanelInternals.chartRangeIsZoomed({ min: 0, max: 100 }, { min: 10, max: 90 }), true);
  assert.strictEqual(resultsPanelInternals.chartRangeIsZoomed({ min: 0, max: 100 }, null), false);
  assert.strictEqual(resultsPanelInternals.chartColumnSignature(['time', 'sym', 'price']), '["time","sym","price"]');
  assert.ok(resultsPanelInternals.chartSelectionStorageKey(['time', 'sym', 'price']).startsWith('kdb-sqltools.results.kdbPanel.chartSelection.v1.'));
  assert.strictEqual(
    resultsPanelInternals.chartSelectionStorageKey(['time', 'sym', 'price']),
    resultsPanelInternals.chartSelectionStorageKey(['time', 'sym', 'price'])
  );
  assert.notStrictEqual(
    resultsPanelInternals.chartSelectionStorageKey(['time', 'sym', 'price']),
    resultsPanelInternals.chartSelectionStorageKey(['time', 'price', 'sym'])
  );
  const persistedChartOptions = {
    xColumns: [
      { columnName: 'time', columnIndex: 0, kind: 'temporal' },
      { columnName: 'open', columnIndex: 1, kind: 'numeric' },
    ],
    yColumns: [
      { columnName: 'open', columnIndex: 1, kind: 'numeric' },
      { columnName: 'high', columnIndex: 2, kind: 'numeric' },
      { columnName: 'low', columnIndex: 3, kind: 'numeric' },
      { columnName: 'close', columnIndex: 4, kind: 'numeric' },
      { columnName: 'price', columnIndex: 5, kind: 'numeric' },
    ],
    groupColumns: [{ columnName: 'sym', columnIndex: 6, kind: 'categorical' }],
    warnings: [],
  };
  assert.deepStrictEqual(resultsPanelInternals.normalizeSavedChartSelection({
    chartType: 'line',
    xColumn: 'time',
    yColumns: ['price'],
    groupByColumn: 'sym',
  }), {
    chartType: 'line',
    xColumn: 'time',
    yColumns: ['price'],
    groupByColumn: 'sym',
  });
  assert.strictEqual(resultsPanelInternals.normalizeSavedChartSelection({
    chartType: 'candlestick',
    xColumn: 'time',
    yColumns: ['open', 'high', 'low', 'close'],
  }), null, 'old generic Y selections must not be reinterpreted as OHLC roles');
  const savedCandleSelection = resultsPanelInternals.normalizeSavedChartSelection({
    chartType: 'candlestick',
    xColumn: 'time',
    yColumns: ['price'],
    groupByColumn: 'sym',
    openColumn: 'open',
    highColumn: 'high',
    lowColumn: 'low',
    closeColumn: 'close',
  });
  assert.deepStrictEqual(savedCandleSelection, {
    chartType: 'candlestick',
    xColumn: 'time',
    yColumns: [],
    openColumn: 'open',
    highColumn: 'high',
    lowColumn: 'low',
    closeColumn: 'close',
  });
  assert.deepStrictEqual(
    resultsPanelInternals.compatibleChartSelection(savedCandleSelection, persistedChartOptions),
    savedCandleSelection
  );
  assert.strictEqual(resultsPanelInternals.compatibleChartSelection({
    ...savedCandleSelection,
    closeColumn: 'open',
  }, persistedChartOptions), null);
  assert.deepStrictEqual(resultsPanelInternals.normalizeSavedChartSelection({
    chartType: 'box',
    xColumn: 'time',
    yColumns: ['price'],
    groupByColumn: 'sym',
  }), {
    chartType: 'box',
    xColumn: 'time',
    yColumns: ['price'],
    groupByColumn: undefined,
  });
  const renderedPanelHtml = resultsPanelInternals.renderResultsPanelHtml(path.join(__dirname, '..'));
  const inlineScriptStart = renderedPanelHtml.lastIndexOf('<script nonce="');
  const inlineScriptBodyStart = renderedPanelHtml.indexOf('>', inlineScriptStart) + 1;
  const inlineScriptEnd = renderedPanelHtml.indexOf('</script>', inlineScriptBodyStart);
  assert.ok(inlineScriptStart >= 0 && inlineScriptBodyStart > inlineScriptStart && inlineScriptEnd > inlineScriptBodyStart);
  assert.doesNotThrow(() => new Function(renderedPanelHtml.slice(inlineScriptBodyStart, inlineScriptEnd)), 'webview inline script should parse');
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('cellWidth', '1000.9'), { key: 'cellWidth', value: 600 });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('rowHeight', 19), { key: 'rowHeight', value: 20 });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('fontSize', 'abc'), null);
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('density', 'compact'), { key: 'density', value: 'compact' });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('density', 'spacious'), null);
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('includeHeaders', false), { key: 'includeHeaders', value: false });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('includeHeaders', 'false'), null);
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('hideLargeResultWarnings', true), { key: 'hideLargeResultWarnings', value: true });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('hideLargeSortWarnings', true), { key: 'hideLargeSortWarnings', value: true });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('copyExportConfirmCellThreshold', 1000000000000), { key: 'copyExportConfirmCellThreshold', value: 1000000000000 });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('localDataServerFullExportCellLimit', 1.9), { key: 'localDataServerFullExportCellLimit', value: 1 });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('localDataServerFullExportCellLimit', 0), null);
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('chartDecimalPlaces', '13.9'), { key: 'chartDecimalPlaces', value: 12 });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('chartDecimalPlaces', 'abc'), null);
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('elapsedTimeDisplay', 'milliseconds'), { key: 'elapsedTimeDisplay', value: 'milliseconds' });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('elapsedTimeDisplay', 'seconds'), null);
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('arrayDisplayFormat', 'space'), { key: 'arrayDisplayFormat', value: 'space' });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('arrayDisplayFormat', 'raw'), { key: 'arrayDisplayFormat', value: 'raw' });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('arrayDisplayFormat', 'comma'), null);
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('functionDisplayStrategy', 'text'), { key: 'functionDisplayStrategy', value: 'qText' });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('functionDisplayStrategy', 'table'), { key: 'functionDisplayStrategy', value: 'grid' });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('dictionaryDisplayStrategy', 'qText'), { key: 'dictionaryDisplayStrategy', value: 'qText' });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('listDisplayStrategy', 'grid'), { key: 'listDisplayStrategy', value: 'grid' });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('objectDisplayStrategy', 'summary'), null);
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('constructor', 1), null);
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('__proto__', true), null);
  assert.strictEqual(resultsPanelInternals.panelSettingConfigKey('cellWidth', 'compact'), 'compact.cellWidth');
  assert.strictEqual(resultsPanelInternals.panelSettingConfigKey('rowHeight', 'comfortable'), 'comfortable.rowHeight');
  assert.strictEqual(resultsPanelInternals.panelSettingConfigKey('includeHeaders', 'compact'), 'includeHeaders');
  assert.strictEqual(resultsPanelInternals.panelSettingConfigKey('arrayDisplayFormat', 'compact'), 'kdbPanel.arrayDisplayFormat');
  assert.strictEqual(resultsPanelInternals.panelSettingConfigKey('functionDisplayStrategy', 'compact'), 'kdbPanel.functionDisplayStrategy');
  assert.strictEqual(resultsPanelInternals.panelSettingConfigKey('dictionaryDisplayStrategy', 'compact'), 'kdbPanel.dictionaryDisplayStrategy');
  assert.strictEqual(
    resultsPanelInternals.panelSizeSettingValue(140, { defaultValue: 140 }, 500, { globalValue: 500 }, 140, 160, 80, 600),
    500
  );
  assert.strictEqual(
    resultsPanelInternals.panelSizeSettingValue(1000.9, { workspaceValue: 1000.9 }, 500, { globalValue: 500 }, 140, 160, 80, 600),
    600
  );
  assert.strictEqual(
    resultsPanelInternals.panelSizeSettingValue('abc', { globalValue: 'abc' }, 500, { globalValue: 500 }, 140, 160, 80, 600),
    140
  );
  assert.strictEqual(
    resultsPanelInternals.panelSizeSettingValue(undefined, undefined, undefined, undefined, 24, 28, 20, 80),
    24
  );
  const validPngDataUrl = 'data:image/png;base64,' + Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
  ]).toString('base64');
  const chartPngBytes = resultsPanelInternals.chartPngBytesFromDataUrl(validPngDataUrl);
  assert.strictEqual(Buffer.from(chartPngBytes).slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.throws(
    () => resultsPanelInternals.chartPngBytesFromDataUrl('data:image/jpeg;base64,AAAA'),
    /PNG data URL/
  );
  assert.throws(
    () => resultsPanelInternals.chartPngBytesFromDataUrl('data:image/png;base64,not base64'),
    /Invalid chart PNG data URL/
  );
  assert.throws(
    () => resultsPanelInternals.chartPngBytesFromDataUrl('data:image/png;base64,AAAA'),
    /Invalid chart PNG data/
  );
  const xlsxColumnar = rowsToColumnarPanelResult([{ note: 'x\u0001<&>"\'' }], ['note']);
  const xlsxBytes = await resultsPanelInternals.columnarToXlsx(
    xlsxColumnar,
    { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
    true,
    true
  );
  const xlsxZip = await JSZip.loadAsync(Buffer.from(xlsxBytes));
  const xlsxSheet = xlsxZip.file('xl/worksheets/sheet1.xml');
  assert.ok(xlsxSheet, 'XLSX export should include sheet1.xml');
  const xlsxSheetXml = await xlsxSheet.async('string');
  assert.strictEqual(xlsxSheetXml.includes('<dimension ref="A1:B2"/>'), true);
  assert.strictEqual(xlsxSheetXml.includes('x\u0001'), false);
  assert.strictEqual(xlsxSheetXml.includes('x&lt;&amp;&gt;&quot;&apos;'), true);
  assert.strictEqual(xlsxSheetXml.includes('<t xml:space="preserve">#</t>'), true);
  await assert.rejects(
    () => resultsPanelInternals.columnarToXlsx(
      xlsxColumnar,
      { startRow: 0, endRow: 1048575, startColumn: 0, endColumn: 0 },
      true,
      false
    ),
    /XLSX export exceeds Excel sheet limits/
  );
  assert.strictEqual(resultsPanelSource.includes('await this.copyRange(\n        message.version,'), true);
  assert.strictEqual(resultsPanelSource.includes('await this.exportRange(\n        message.version,'), true);
  assert.strictEqual(resultsPanelSource.includes('await this.exportChartPng(message);'), true);
  assert.strictEqual(resultsPanelSource.includes('const requestVersion = integerOrNull(version);'), true);
  assert.strictEqual(resultsPanelSource.includes('await this.exportRange(requestVersion, clamped, format, includeHeaders, includeRowIndex)'), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'sortSkipped', version: requestVersion"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'copySkipped', version: requestVersion"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'exportSkipped', version: requestVersion"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'copied', version: requestVersion"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'exported', version: requestVersion"), true);
  assert.strictEqual(resultsPanelSource.includes('chartPngBytesFromDataUrl(message.dataUrl)'), true);
  assert.strictEqual(resultsPanelSource.includes('requestId !== this.activeChartRequestId'), true);
  assert.strictEqual(resultsPanelSource.includes('defaultUri: defaultChartExportUri()'), true);
  assert.strictEqual(resultsPanelSource.includes("filters: { PNG: ['png'] }"), true);
  assert.strictEqual(resultsPanelSource.includes('await vscode.workspace.fs.writeFile(uri, content);'), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'chartExported', version: requestVersion, requestId"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'chartExportSkipped', version: requestVersion, requestId"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'chartExportError', version: requestVersion, requestId"), true);
  assert.strictEqual(chartingDocsSource.includes('Export PNG'), true);
  assert.strictEqual(resultsDocsSource.includes('The toolbar is a single compact line'), true);
  assert.strictEqual(resultsDocsSource.includes('Settings menu'), true);
  assert.strictEqual(resultsDocsSource.includes('Data server subgroup'), false);
  assert.strictEqual(resultsDocsSource.includes('Data server is collapsed by default'), true);
  assert.strictEqual(resultsDocsSource.includes('Chart button'), true);
  assert.strictEqual(localDataDocsSource.includes('Open `Settings`.'), true);
  assert.strictEqual(localDataDocsSource.includes('Expand the collapsed `Data server` section.'), true);
  assert.strictEqual(localDataDocsSource.includes('section shows a short `host:port` badge'), true);
  assert.strictEqual(localDataDocsSource.includes('The copy/export confirmation threshold does not raise this server hard limit'), true);
  assert.strictEqual(copyExportDocsSource.includes('copyExportConfirmCellThreshold'), true);
  assert.strictEqual(settingsDocsSource.includes('localDataServerFullExportCellLimit'), true);
  assert.strictEqual(resultsPanelSource.includes('id="expandSettingsSections"'), true);
  assert.strictEqual(resultsPanelSource.includes('<details class="settings-section" id="dataServerSection">'), true);
  assert.strictEqual(resultsPanelSource.includes('<details class="settings-section" open>'), true);
  assert.strictEqual(resultsPanelSource.includes('For very large current.csv/json/ndjson exports'), true);
  assert.strictEqual(resultsPanelSource.includes('let autoFitEnabled = true;'), true);
  assert.strictEqual(resultsPanelSource.includes('id="settingsCopyExportConfirmCellThreshold"'), true);
  assert.strictEqual(resultsPanelSource.includes('id="settingsLocalDataServerFullExportCellLimit"'), true);
  assert.strictEqual(packageJson.contributes.configuration.properties['kdb-sqltools.results.copyExportConfirmCellThreshold'].minimum, 1);
  assert.strictEqual(packageJson.contributes.configuration.properties['kdb-sqltools.results.localDataServerFullExportCellLimit'].minimum, 1);
  assert.strictEqual(packageJson.version, '0.3.17');
  assert.strictEqual(chartingDocsSource.includes('Press the top-level `Chart` button.'), true);
  assert.strictEqual(chartingDocsSource.includes('kdb+: Run Selection and Chart'), true);
  assert.strictEqual(runningDocsSource.includes('| `Ctrl+Alt+C` | `Cmd+Alt+C` | `kdb+: Run Selection and Chart`'), true);
  assert.strictEqual(runningDocsSource.includes('If there is no selection, it sends the current q block bounded by blank lines'), false);
  assert.strictEqual(readmeSource.includes('with no selection, it sends the current q block bounded by blank lines'), false);
  assert.strictEqual(runningDocsSource.includes('If there is no selection, it sends the current physical line'), true);
  assert.strictEqual(runningDocsSource.includes('Run Selection or q Block'), true);
  assert.strictEqual(runningDocsSource.includes('current q block bounded by blank lines'), true);
  assert.strictEqual(runningDocsSource.includes('For multi-line, lambda, or blank-line-bounded block execution'), true);
  assert.strictEqual(readmeSource.includes('with no selection, it sends the current physical line'), true);
  assert.strictEqual(readmeSource.includes('Run Selection or q Block'), true);
  assert.strictEqual(readmeSource.includes('The top toolbar is a single compact line'), true);
  assert.strictEqual(readmeSource.includes('`Settings` contains collapsible sections for view controls, search, hidden columns, output defaults, and `Data server` controls'), true);
  assert.strictEqual(chartingDocsSource.includes('PNG export saves the rendered uPlot canvas'), true);
  assert.strictEqual(chartingDocsSource.includes('X-axis labels are auto-thinned'), true);
  assert.strictEqual(chartingDocsSource.includes('dense numeric and timestamp axes readable'), true);
  assert.strictEqual(readmeSource.includes('auto-thinned readable x-axis labels'), true);
  assert.strictEqual(resultsDocsSource.includes('auto-thinned readable x-axis labels'), true);
  assert.strictEqual(chartingDocsSource.includes('uPlot powers the built-in chart'), true);
  assert.strictEqual(chartingDocsSource.includes('cursor/crosshair tooltip'), true);
  assert.strictEqual(chartingDocsSource.includes('drag-select zoom'), true);
  assert.strictEqual(chartingDocsSource.includes('Reset zoom'), true);
  assert.strictEqual(chartingDocsSource.includes('restores the original full x-range'), true);
  assert.strictEqual(chartingDocsSource.includes('disables again at that baseline'), true);
  assert.strictEqual(chartingDocsSource.includes('kdb-sqltools.results.kdbPanel.chartDecimalPlaces'), true);
  assert.strictEqual(chartingDocsSource.includes('kdb-sqltools.results.kdbPanel.chartZoomMinSampledPoints'), true);
  assert.strictEqual(chartingDocsSource.includes('kdb-sqltools.results.kdbPanel.chartZoomMaxSampledPoints'), true);
  assert.strictEqual(chartingDocsSource.includes('after about 450 ms'), true);
  assert.strictEqual(chartingDocsSource.includes('visible column names and order as the signature'), true);
  assert.strictEqual(chartingDocsSource.includes('Temporal timestamp labels do not use this numeric decimal formatting.'), true);
  assert.strictEqual(chartingDocsSource.includes('small built-in canvas renderer'), false);
  assert.strictEqual(chartingDocsSource.includes('basic canvas renderer'), false);
  assert.strictEqual(/cdn\.jsdelivr|unpkg|cdnjs|https:\/\/cdn/i.test(chartingDocsSource), false);
  assert.strictEqual(chartingDocsSource.includes('kdb-sqltools.results.kdbPanel.chartMaxSourceRows'), true);
  assert.strictEqual(settingsDocsSource.includes('kdb-sqltools.results.kdbPanel.chartMaxSourceRows'), true);
  assert.strictEqual(settingsDocsSource.includes('kdb-sqltools.results.kdbPanel.chartDecimalPlaces'), true);
  assert.strictEqual(settingsDocsSource.includes('kdb-sqltools.results.kdbPanel.chartZoomMinSampledPoints'), true);
  assert.strictEqual(settingsDocsSource.includes('kdb-sqltools.results.kdbPanel.chartZoomMaxSampledPoints'), true);
  assert.strictEqual(resultsDocsSource.includes('## Non-table q result display'), true);
  assert.strictEqual(resultsDocsSource.includes('kdb-sqltools.results.kdbPanel.dictionaryDisplayStrategy'), true);
  assert.strictEqual(settingsDocsSource.includes('kdb-sqltools.results.kdbPanel.functionDisplayStrategy'), true);
  assert.strictEqual(settingsDocsSource.includes('kdb-sqltools.results.kdbPanel.dictionaryDisplayStrategy'), true);
  assert.strictEqual(settingsDocsSource.includes('kdb-sqltools.results.kdbPanel.listDisplayStrategy'), true);
  assert.strictEqual(settingsDocsSource.includes('kdb-sqltools.results.kdbPanel.objectDisplayStrategy'), true);
  assert.strictEqual(/source-unavailable message/.test(resultsDocsSource + settingsDocsSource), true);
  assert.strictEqual((resultsDocsSource + settingsDocsSource).includes('return `string f` or `.Q.s f`'), true);
  assert.strictEqual(chartingDocsSource.includes('no hard upper bound'), true);
  assert.strictEqual(settingsDocsSource.includes('no hard upper bound'), true);
  assert.strictEqual(/temporarily block the extension host/.test(chartingDocsSource), true);
  assert.strictEqual(/temporarily block the extension host/.test(settingsDocsSource), true);
  const unsupportedChartExportPhrase = [
    'chart export features are',
    'not implemented',
  ].join(' ');
  assert.strictEqual(chartingDocsSource.includes(unsupportedChartExportPhrase), false);
  assert.strictEqual(resultsPanelSource.includes('private isCurrentVersion(version: number): boolean'), true);
  assert.strictEqual(resultsPanelSource.includes('function isCurrentVersionMessage(msg)'), true);
  assert.strictEqual(resultsPanelSource.includes("msg.type === 'copied' && isCurrentVersionMessage(msg)"), true);
  assert.strictEqual(resultsPanelSource.includes("data-vscode-context='{\"webviewSection\":\"kdbResultsTable\",\"preventDefaultContextMenuItems\":true}'"), true);
  assert.strictEqual(resultsPanelSource.includes("viewport.addEventListener('contextmenu'"), true);
  assert.strictEqual(resultsPanelSource.includes("vscode.postMessage({ type: 'tableContextMenu' });"), true);
  assert.strictEqual(resultsPanelSource.includes("message.type === 'tableContextMenu'"), true);
  assert.strictEqual(resultsPanelSource.includes("msg.type === 'copySelection'"), true);
  assert.strictEqual(resultsPanelSource.includes('public static copySelectionFromActivePanel(): void'), true);
  const copySelectionSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function copySelection'),
    resultsPanelSource.indexOf('function exportSelection')
  );
  const exportSelectionSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function exportSelection'),
    resultsPanelSource.indexOf('function sliceCovers')
  );
  assert.strictEqual(copySelectionSource.includes('version: data.version'), true);
  assert.strictEqual(exportSelectionSource.includes('version: data.version'), true);
  assert.strictEqual(copySelectionSource.includes("if (format === 'xlsx')"), true);
  assert.strictEqual(copySelectionSource.includes('XLSX is export-only'), true);
  const setActionsDisabledSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function setActionsDisabled'),
    resultsPanelSource.indexOf('function updateActionState')
  );
  assert.strictEqual(setActionsDisabledSource.includes("copyButton.disabled = disabled || (!textMode && String(actionFormat.value || '') === 'xlsx');"), true);
  assert.strictEqual(setActionsDisabledSource.includes('exportButton.disabled = disabled;'), true);
  assert.strictEqual(setActionsDisabledSource.includes('includeHeadersLabel.hidden = textMode;'), true);
  assert.strictEqual(setActionsDisabledSource.includes('includeRowIndexLabel.hidden = textMode;'), true);
  assert.strictEqual(
    resultsPanelSource.includes("value.replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F&<>\"']/g"),
    true
  );
  assert.strictEqual(resultsPanelSource.includes('layout.showRowIndex'), true);
  assert.strictEqual(resultsPanelSource.includes('const showRowIndex = settings.showRowIndex || (data.rowCount > 0 && data.columns.length === 0);'), true);
  assert.strictEqual(resultsPanelSource.includes('indexWidth: showRowIndex ? INDEX_WIDTH : 0'), true);
  assert.strictEqual(kdbResultsSource.includes('filterColumnarPanelResult'), true);
  assert.strictEqual(resultsPanelSource.includes('hiddenColumnNames'), true);
  assert.strictEqual(resultsPanelSource.includes('private hiddenColumnSchema'), true);
  assert.strictEqual(resultsPanelSource.includes('hiddenColumnNamesForNewResult(result.table.columns)'), true);
  assert.strictEqual(resultsPanelSource.includes('sameColumnNames(this.hiddenColumnSchema, columns)'), true);
  assert.strictEqual(resultsPanelSource.includes('At least one column must stay visible'), false);
  assert.strictEqual(resultsPanelSource.includes("message.type === 'hideAllColumns'"), true);
  assert.strictEqual(resultsPanelSource.includes("message.type === 'showAllColumns'"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'hideAllColumns'"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'showAllColumns'"), true);
  assert.strictEqual(resultsPanelSource.includes('id="selectAllColumns"'), true);
  assert.strictEqual(resultsPanelSource.includes('id="deselectAllColumns"'), true);
  assert.strictEqual(resultsPanelSource.includes('No visible data columns'), true);
  assert.strictEqual(resultsPanelSource.includes('return names.length >= columns.length'), false);
  assert.strictEqual(readmeSource.includes('only when the full column list matches'), true);
  assert.strictEqual(resultsPanelSource.includes("message.type === 'hideColumn'"), true);
  assert.strictEqual(resultsPanelSource.includes("message.type === 'showColumn'"), true);
  assert.strictEqual(resultsPanelSource.includes("message.type === 'resetHiddenColumns'"), true);
  assert.strictEqual(resultsPanelSource.includes('id="autoFit"'), true);
  assert.strictEqual(resultsPanelSource.includes('id="autoFitColumns"'), false);
  assert.strictEqual(resultsPanelSource.includes('function setAutoFitEnabled(enabled)'), true);
  assert.strictEqual(resultsPanelSource.includes("autoFit.addEventListener('change'"), true);
  assert.strictEqual(resultsPanelSource.includes('function autoFitVisibleColumnWidths()'), false);
  assert.strictEqual(resultsPanelSource.includes('let lastRenderedColumns = emptyColumnRange();'), true);
  assert.strictEqual(resultsPanelSource.includes('function updateAutoColumnWidthsFromSlice()'), true);
  assert.strictEqual(resultsPanelSource.includes('if (!autoFitEnabled || !hasVisibleSliceColumns())'), true);
  assert.strictEqual(resultsPanelSource.includes("lastRenderedColumns = columns;"), true);
  assert.strictEqual(resultsPanelSource.includes("' visible columns' + (includeSlice ? '' : ' from headers')"), false);
  assert.strictEqual(
    resultsPanelSource.includes('const noVisibleColumns = columnCount === 0 && (rowCount > 0 || data.allColumns.length > 0);'),
    true
  );
  assert.strictEqual(resultsPanelSource.includes('measuredColumnTextWidth(data.columns[column])'), true);
  assert.strictEqual(resultsPanelSource.includes('AUTO_COLUMN_WIDTH_CAP'), true);
  assert.strictEqual(packageSource.includes('hiddenColumn'), false, 'hidden columns must not be globally persisted');
  assert.deepStrictEqual(htmlSelectOptions(resultsPanelSource, 'interactionMode'), ['drag', 'select', 'sort']);
  assert.ok(
    resultsPanelSource.indexOf('<option value="drag">Drag</option>') < resultsPanelSource.indexOf('<option value="select">Select</option>'),
    'header mode must default to Drag'
  );
  const visibleTableSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('private visibleTable'),
    resultsPanelSource.indexOf('private visibleSortState')
  );
  assert.strictEqual(visibleTableSource.includes('applyColumnarRowOrder(table, this.rowOrder)'), true);
  assert.strictEqual(resultsPanelSource.includes('private columnOrder'), true);
  assert.strictEqual(resultsPanelSource.includes('columnOrderForNewResult(result.table.columns)'), true);
  assert.strictEqual(resultsPanelSource.includes('message.type === \'reorderColumn\''), true);
  assert.strictEqual(resultsPanelSource.includes('private reorderColumn(message: any): void'), true);
  assert.strictEqual(resultsPanelSource.includes('mergeVisibleColumnOrder'), true);
  assert.strictEqual(kdbResultsSource.includes('visibleColumns.map(column => String(column)).forEach'), true);
  assert.strictEqual(resultsPanelSource.includes('.header.drag-active'), true);
  assert.strictEqual(resultsPanelSource.includes('transform: translateY(-2px);'), true);
  assert.strictEqual(resultsPanelSource.includes('.header .cell.drag-target-before::before'), true);
  assert.strictEqual(resultsPanelSource.includes('.header .cell.drag-target-after::after'), true);
  assert.strictEqual(resultsPanelSource.includes("className += ' drag-target-' + position;"), true);
  assert.strictEqual(resultsPanelSource.includes("header.className = columnDragState && dragMode === 'reorder' ? 'header drag-active' : 'header';"), true);
  assert.strictEqual(resultsPanelSource.includes("cell.title = String(options.title || options.text || '');"), true);
  assert.strictEqual(resultsPanelSource.includes("return sourceColumn < targetColumn ? 'after' : 'before';"), true);
  assert.strictEqual(resultsPanelSource.includes("status.textContent = columnDragStatusText();"), true);
  const columnDragCleanupSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function clearColumnDragState'),
    resultsPanelSource.indexOf('function columnDragDropPosition')
  );
  assert.strictEqual(columnDragCleanupSource.includes('columnDragState = null;'), true);
  assert.strictEqual(columnDragCleanupSource.includes("document.body.style.cursor = '';"), true);
  const resetWindowStateSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function resetWindowState'),
    resultsPanelSource.indexOf('function queueSearchRows')
  );
  assert.strictEqual(resetWindowStateSource.includes('clearColumnDragState();'), true);
  const mouseupSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf("window.addEventListener('mouseup'"),
    resultsPanelSource.indexOf("window.addEventListener('resize'")
  );
  assert.strictEqual(mouseupSource.includes('finishColumnReorder();'), true);
  assert.strictEqual(mouseupSource.includes('clearColumnDragState();'), true);
  const sortColumnSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('private async sortColumn'),
    resultsPanelSource.indexOf('private async copyRange')
  );
  assert.strictEqual(sortColumnSource.includes('const table = this.baseVisibleTable();'), true);
  assert.strictEqual(sortColumnSource.includes('this.rowOrder = sortedRowOrder;'), true);
  assert.strictEqual(sortColumnSource.includes('sortedColumnarRowOrder(table, columnIndex, nextSort.direction, panelCellTextOptions())'), true);
  assert.strictEqual(sortColumnSource.includes('perfSpan(\'results-panel.sort\''), true);
  assert.strictEqual(sortColumnSource.includes('SORT_CONFIRM_ROW_THRESHOLD'), true);
  const sortHelperSource = kdbResultsSource.slice(
    kdbResultsSource.indexOf('export function sortedColumnarRowOrder'),
    kdbResultsSource.indexOf('export function compareColumnarCellText')
  );
  assert.strictEqual(sortHelperSource.includes('result.cellText(rowIndex, columnIndex, options)'), true);
  assert.strictEqual(sortHelperSource.includes('RowValue'), false, 'sort must not materialize row objects');
  const columnMouseSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function onColumnMouseDown'),
    resultsPanelSource.indexOf('function onColumnMouseEnter')
  );
  assert.strictEqual(columnMouseSource.includes("if (headerMode() === 'sort')"), true);
  assert.strictEqual(columnMouseSource.includes("if (headerMode() === 'drag')"), true);
  assert.strictEqual(columnMouseSource.includes("type: 'sortColumn'"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'reorderColumn'"), true);
  assert.ok(
    columnMouseSource.indexOf("type: 'sortColumn'") < columnMouseSource.indexOf("dragging = true"),
    'header click sorting must require Sort mode before column selection starts'
  );
  const postSliceSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('private postSlice'),
    resultsPanelSource.indexOf('private async copyRange')
  );
  assert.strictEqual(postSliceSource.includes('const table = this.visibleTable();'), true);
  assert.strictEqual(postSliceSource.includes('table.cellWindow(rowRange, columnRange, cellTextOptions)'), true);
  assert.strictEqual(postSliceSource.includes('this.result.table.cellWindow'), false);
  const searchRowsSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('private async searchRows'),
    resultsPanelSource.indexOf('private async copyRange')
  );
  assert.strictEqual(resultsPanelSource.includes('id="searchInput"'), true);
  assert.strictEqual(resultsPanelSource.includes("setTimeout(() => sendSearchRows(searchId, query), 250)"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'searchRows'"), true);
  assert.strictEqual(resultsPanelSource.includes("msg.type === 'searchResults'"), true);
  assert.strictEqual(resultsPanelSource.includes("search.partial ? 'No matches (partial)' : 'No matches'"), true);
  assert.strictEqual(searchRowsSource.includes('const table = this.visibleTable();'), true);
  assert.strictEqual(searchRowsSource.includes('table.cellText(rowIndex, columnIndex, cellTextOptions)'), true);
  assert.strictEqual(searchRowsSource.includes('matchedRows'), true);
  assert.strictEqual(searchRowsSource.includes('totalScanned'), true);
  assert.strictEqual(searchRowsSource.includes('capped'), true);
  assert.strictEqual(searchRowsSource.includes('partial'), true);
  assert.strictEqual(searchRowsSource.includes('matchCap: SEARCH_MATCH_CAP'), true);
  assert.strictEqual(searchRowsSource.includes('await yieldToEventLoop()'), true);
  assert.strictEqual(searchRowsSource.includes('cellWindow'), false, 'search must not post or build cell windows');
  const copyRangeSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('private async copyRange'),
    resultsPanelSource.indexOf('private async exportRange')
  );
  assert.strictEqual(
    copyRangeSource.includes('await vscode.env.clipboard.writeText(text);\n    if (!this.isCurrentVersion(requestVersion))'),
    true
  );
  const exportRangeSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('private async exportRange'),
    resultsPanelSource.indexOf('private async confirmLargeCopyExport')
  );
  assert.ok(
    exportRangeSource.indexOf('const content = format ===') < exportRangeSource.indexOf('await vscode.workspace.fs.writeFile(uri, content)'),
    'export content should be generated before writing'
  );
  assert.strictEqual(
    exportRangeSource.includes('if (!this.isCurrentVersion(requestVersion)) {\n      return;\n    }\n    await vscode.workspace.fs.writeFile(uri, content)'),
    true
  );
  assert.strictEqual(exportRangeSource.includes("type: 'exportSkipped', format"), false);
  assert.strictEqual(perfModule.PERF_PREFIX, '[kdb-sqltools:perf]');
  assert.strictEqual(typeof perfModule.configurePerfTrace, 'function');
  assert.strictEqual(typeof perfModule.isPerfTraceEnabled, 'function');
  assert.strictEqual(typeof perfModule.perfSpan, 'function');
  assert.strictEqual(perfSource.includes('process.memoryUsage()'), true);
  assert.strictEqual(perfSource.includes('KDB_SQLTOOLS_PERF'), true);
  assert.strictEqual(perfSource.includes('kdb-sqltools.performance'), true);
  const previousPerfEnv = process.env.KDB_SQLTOOLS_PERF;
  try {
    delete process.env.KDB_SQLTOOLS_PERF;
    perfModule.configurePerfTrace(false);
    assert.strictEqual(perfModule.isPerfTraceEnabled(), false);
    perfModule.configurePerfTrace(true);
    assert.strictEqual(perfModule.isPerfTraceEnabled(), true);
    perfModule.configurePerfTrace(undefined);
    process.env.KDB_SQLTOOLS_PERF = '1';
    assert.strictEqual(perfModule.isPerfTraceEnabled(), true);
  } finally {
    if (previousPerfEnv === undefined) {
      delete process.env.KDB_SQLTOOLS_PERF;
    } else {
      process.env.KDB_SQLTOOLS_PERF = previousPerfEnv;
    }
    perfModule.configurePerfTrace(undefined);
  }

  assert.strictEqual(
    deserializeQMessage(hex('010000000d000000fa01000000')),
    1
  );

  const table = deserializeQMessage(hex(
    '01000000620000006200630b0003000000610062006300000003000000070003000000010000000000000002000000000000000300000000000000010003000000010001090003000000000000000000f03f00000000000000400000000000000840'
  ));
  assert.strictEqual(qValueRowsMaterialized(table), false, 'decoded q tables should start with lazy rows');
  const columnarTable = qValueToColumnarPanel(table);
  assert.strictEqual(columnarTable.kind, 'table');
  assert.strictEqual(columnarTable.result.rowCount, 3);
  assert.strictEqual(qValueRowsMaterialized(table), false, 'columnar panel conversion should not materialize table rows');
  assert.deepStrictEqual(
    columnarTable.result.cellWindow({ start: 0, end: 1 }, { start: 1, end: 2 }),
    rowsToCellWindow(
      [
        { a: 1, b: true, c: 1 },
        { a: 2, b: false, c: 2 },
        { a: 3, b: true, c: 3 },
      ],
      ['a', 'b', 'c'],
      { start: 0, end: 1 },
      { start: 1, end: 2 }
    )
  );
  const tableResult = qValueToTabular(table);
  assert.strictEqual(qValueRowsMaterialized(table), true, 'SQLTools tabular conversion should still materialize rows');
  assert.deepStrictEqual(tableResult.cols, ['a', 'b', 'c']);
  assert.deepStrictEqual(tableResult.rows, [
    { a: 1, b: true, c: 1 },
    { a: 2, b: false, c: 2 },
    { a: 3, b: true, c: 3 },
  ]);

  const duplicateColumnPayload = qTable(
    ['a', 'a', 'a_1'],
    [intVector([1, 2]), intVector([3, 4]), intVector([5, 6])]
  );
  const duplicateColumnarTable = deserializeQPayload(duplicateColumnPayload);
  const duplicateColumnarResult = qValueToColumnarPanel(duplicateColumnarTable);
  assert.deepStrictEqual(duplicateColumnarResult.cols, ['a', 'a_1', 'a_1_1']);
  assert.strictEqual(qValueRowsMaterialized(duplicateColumnarTable), false);
  assert.deepStrictEqual(
    duplicateColumnarResult.result.cellWindow({ start: 0, end: 1 }, { start: 0, end: 2 }).cells,
    [
      ['1', '3', '5'],
      ['2', '4', '6'],
    ]
  );
  assert.strictEqual(
    duplicateColumnarResult.result.toText('json', { startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 }, {
      includeRowIndex: true,
    }),
    '[{"#":1,"a":1,"a_1":3,"a_1_1":5}]'
  );
  assert.strictEqual(
    duplicateColumnarResult.result.toText('csv', { startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 }, {
      includeHeaders: true,
      includeRowIndex: true,
    }),
    '#,a,a_1,a_1_1\n1,1,3,5'
  );
  const duplicateTableResult = qValueToTabular(deserializeQPayload(duplicateColumnPayload));
  assert.deepStrictEqual(duplicateTableResult.cols, ['a', 'a_1', 'a_1_1']);
  assert.deepStrictEqual(duplicateTableResult.rows, [
    { a: 1, a_1: 3, a_1_1: 5 },
    { a: 2, a_1: 4, a_1_1: 6 },
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
  const dictColumnarGrid = qValueToColumnarPanel(dict);
  assert.deepStrictEqual(dictColumnarGrid.result.columns, ['key', 'value']);
  assert.strictEqual(dictColumnarGrid.result.rowCount, 3);
  const dictColumnarText = qValueToColumnarPanel(dict, { dictionaryDisplayStrategy: 'qText' });
  assert.strictEqual(dictColumnarText.mode, 'text');
  assert.strictEqual(dictColumnarText.text, '("a";"b";"c")!1 2 3');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(dictColumnarText, 'result'), false);
  const dictColumnarTextAlias = qValueToColumnarPanel(dict, { dictionaryDisplayStrategy: 'text' });
  assert.strictEqual(dictColumnarTextAlias.mode, 'text');
  assert.strictEqual(dictColumnarTextAlias.text, '("a";"b";"c")!1 2 3');
  assert.deepStrictEqual(qValueToColumnarPanel(dict, { dictionaryDisplayStrategy: 'table' }).result.columns, ['key', 'value']);

  const charDict = deserializeQMessage(hex(
    '010000001e000000630b00030000006100620063000a000300000078797a'
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
  const lazyKeyedTable = deserializeQPayload(qDict(
    qTable(['sym'], [symbolVector(['AAPL', 'MSFT'])]),
    qTable(['sym', 'size'], [symbolVector(['lit', 'dark']), intVector([100, 250])])
  ));
  assert.strictEqual(qValueRowsMaterialized(lazyKeyedTable), false, 'decoded keyed tables should start with lazy rows');
  const columnarKeyedTable = qValueToColumnarPanel(lazyKeyedTable);
  assert.strictEqual(qValueRowsMaterialized(lazyKeyedTable), false, 'columnar keyed-table conversion should not materialize rows');
  assert.deepStrictEqual(
    columnarKeyedTable.result.cellWindow({ start: 0, end: 1 }, { start: 0, end: 2 }),
    rowsToCellWindow(
      [
        { sym: 'AAPL', sym_1: 'lit', size: 100 },
        { sym: 'MSFT', sym_1: 'dark', size: 250 },
      ],
      ['sym', 'sym_1', 'size'],
      { start: 0, end: 1 },
      { start: 0, end: 2 }
    )
  );
  const tableWithTextStrategies = qValueToColumnarPanel(table, {
    dictionaryDisplayStrategy: 'qText',
    listDisplayStrategy: 'qText',
    objectDisplayStrategy: 'qText',
  });
  assert.strictEqual(tableWithTextStrategies.kind, 'table');
  assert.deepStrictEqual(tableWithTextStrategies.result.columns, ['a', 'b', 'c']);
  assert.strictEqual(tableWithTextStrategies.result.rowCount, 3);

  const nestedTablePayload = qTable(
    ['sym', 'chars', 'nums', 'dict'],
    [
      symbolVector(['AAPL']),
      genericList([charVector('alpha')]),
      genericList([intVector([1, 2, 3])]),
      genericList([qDict(symbolVector(['a', 'b']), intVector([10, 20]))]),
    ]
  );
  const nestedTableResult = qValueToTabular(deserializeQPayload(nestedTablePayload));
  assert.deepStrictEqual(nestedTableResult.cols, ['sym', 'chars', 'nums', 'dict']);
  assert.deepStrictEqual(nestedTableResult.rows, [{
    sym: 'AAPL',
    chars: 'alpha',
    nums: '1, 2, 3',
    dict: '{"a": 10, "b": 20}',
  }]);
  const nestedColumnarResult = qValueToColumnarPanel(deserializeQPayload(nestedTablePayload));
  assert.deepStrictEqual(
    nestedColumnarResult.result.cellWindow({ start: 0, end: 0 }, { start: 0, end: 3 }).cells,
    [['AAPL', 'alpha', '1, 2, 3', '{"a": 10, "b": 20}']]
  );
  assert.deepStrictEqual(
    nestedColumnarResult.result.cellWindow({ start: 0, end: 0 }, { start: 2, end: 2 }, { arrayDisplayFormat: 'space' }).cells,
    [['1 2 3']]
  );
  assert.deepStrictEqual(
    nestedColumnarResult.result.cellWindow({ start: 0, end: 0 }, { start: 2, end: 2 }, { arrayDisplayFormat: 'raw' }).cells,
    [['[1 2 3]']]
  );
  assert.strictEqual(
    nestedColumnarResult.result.toText('json', { startRow: 0, endRow: 0, startColumn: 0, endColumn: 3 }),
    '[{"sym":"AAPL","chars":"alpha","nums":[1,2,3],"dict":{"a":10,"b":20}}]'
  );

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
  const longColumnar = qValueToColumnarPanel(deserializeQPayload(longVector([9007199254740993n, -9007199254740993n])));
  assert.deepStrictEqual(longColumnar.result.columns, ['index', 'value']);
  assert.strictEqual(longColumnar.result.rowCount, 2);
  assert.strictEqual(longColumnar.rowsMaterialized, false);
  assert.deepStrictEqual(longColumnar.result.cellWindow({ start: 0, end: 1 }, { start: 0, end: 1 }).cells, [
    ['0', '9007199254740993'],
    ['1', '-9007199254740993'],
  ]);

  const mixedList = [1, 'alpha', [2, 3], { beta: true }];
  const mixedListGrid = qValueToColumnarPanel(mixedList);
  assert.deepStrictEqual(mixedListGrid.result.columns, ['index', 'value']);
  assert.strictEqual(mixedListGrid.result.rowCount, 4);
  const mixedListText = qValueToColumnarPanel(mixedList, { listDisplayStrategy: 'qText' });
  assert.strictEqual(mixedListText.mode, 'text');
  assert.strictEqual(mixedListText.text, '(1;"alpha";2 3;{beta:1b})');
  const plainObjectText = qValueToColumnarPanel({ alpha: 1, beta: [2, 3] }, { objectDisplayStrategy: 'text' });
  assert.strictEqual(plainObjectText.mode, 'text');
  assert.strictEqual(plainObjectText.text, '{alpha:1;beta:2 3}');
  const eightyItemQText = qValueToQText(Array.from({ length: 80 }, (_, index) => `table_${index}`));
  assert.strictEqual(eightyItemQText.includes('more'), false);
  assert.strictEqual(eightyItemQText.includes('"table_79"'), true);
  assert.strictEqual(qValueToQText([1, 2, 3], { maxItems: 2 }), '1 2 ... 1 more');
  const moderatelyLargeQText = qValueToQText('x'.repeat(20000));
  assert.strictEqual(moderatelyLargeQText.includes('[truncated]'), false);
  assert.strictEqual(moderatelyLargeQText.length, 20002);
  const explicitlyTruncatedQText = qValueToQText('x'.repeat(20000), { maxChars: 100 });
  assert.strictEqual(explicitlyTruncatedQText.endsWith('... [truncated]'), true);
  assert.strictEqual(explicitlyTruncatedQText.length <= 100, true);
  assert.strictEqual(qValueToQText({ a: { b: { c: 1 } } }, { maxDepth: 2 }), '{a:{b:[object 1 fields]}}');

  const lambdaWithSource = deserializeQPayload(Buffer.concat([int8(100), cString(''), charVector('{x+y}')]));
  assert.strictEqual(lambdaWithSource.qtype, 'function');
  assert.strictEqual(lambdaWithSource.functionType, 'lambda');
  assert.strictEqual(lambdaWithSource.source, '{x+y}');
  const lambdaWithSourceColumnar = qValueToColumnarPanel(lambdaWithSource);
  assert.strictEqual(lambdaWithSourceColumnar.mode, 'text');
  assert.strictEqual(lambdaWithSourceColumnar.text, '{x+y}');
  const lambdaWithoutSource = deserializeQPayload(Buffer.concat([int8(100), cString(''), intVector([1, 2])]));
  const lambdaWithoutSourceColumnar = qValueToColumnarPanel(lambdaWithoutSource);
  assert.strictEqual(lambdaWithoutSourceColumnar.mode, 'text');
  assert.match(
    lambdaWithoutSourceColumnar.text,
    /lambda: source unavailable over q IPC; return string f or \.Q\.s f/
  );
  const lambdaGrid = qValueToColumnarPanel(lambdaWithoutSource, { functionDisplayStrategy: 'grid' });
  assert.deepStrictEqual(lambdaGrid.result.columns, ['value']);
  assert.match(lambdaGrid.result.cellText(0, 0), /source unavailable over q IPC/);
  assert.match(qValueToTabular(lambdaWithoutSource).rows[0].value, /source unavailable over q IPC/);

  assert.strictEqual(normalizeNamespace('analytics'), '.analytics');
  assert.strictEqual(normalizeNamespace('.analytics'), '.analytics');
  assert.strictEqual(qString('a"b\\c'), '"a\\"b\\\\c"');
  assert.strictEqual(qSymbolExpression('.analytics.trade'), '`$".analytics.trade"');
  assert.strictEqual(DRIVER_ID, 'KDB');
  assert.deepStrictEqual(
    DRIVER_ALIASES.map(alias => alias.value),
    ['KDB', 'kdb+', 'kdb', 'kdb-sqltools', 'DanielAlonso.kdb-sqltools']
  );
  assert.strictEqual(queryInNamespace('1+1', '.'), '1+1');
  assert.strictEqual(queryInNamespace('1+1', ''), '1+1');
  const namespacedQuery = queryInNamespace('1+1', '.analytics');
  assert.ok(namespacedQuery.includes('old:string system "d"'));
  assert.ok(namespacedQuery.includes('system "d ",ns'));
  assert.ok(namespacedQuery.includes('r:@[{(1b;value x)};src;{(0b;x)}]'));
  assert.ok(namespacedQuery.includes('if[not first r;\'last r]'));
  assert.ok(namespacedQuery.endsWith('}[".analytics";"1+1"]'));
  assert.strictEqual(createDriver().rawQueryText('1+1'), namespacedQuery);

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

  const sqlToolsInsertDriver = createDriver();
  const sqlToolsInsertQueries = [];
  sqlToolsInsertDriver.query = async (query) => {
    sqlToolsInsertQueries.push(query.toString());
    return [{
      cols: ['label', 'dataType', 't', 'a'],
      messages: [],
      results: [
        { label: 'sym', dataType: 's', t: 's', a: '' },
        { label: 'size', dataType: 'i', t: 'i', a: '' },
        { label: 'price', dataType: 'f', t: 'f', a: '' },
      ],
    }];
  };
  const sqlToolsInsert = await sqlToolsInsertDriver.getInsertQuery({
    item: {
      label: 'trade',
      type: ContextValue.TABLE,
      schema: '.analytics',
      database: '.analytics',
      isView: false,
    },
    columns: [
      {
        label: 'Columns',
        type: ContextValue.RESOURCE_GROUP,
        iconId: 'folder',
        childType: ContextValue.COLUMN,
        schema: '.analytics',
        database: '.analytics',
      },
    ],
  });
  assert.strictEqual(sqlToolsInsert, '(`$".analytics.trade") insert (`; 0Ni; 0n, ');
  assert.ok(
    sqlToolsInsertQueries.some(text => text.includes('0!meta tbl')),
    'SQLTools insert generation should resolve the Columns group to real table columns'
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

function loadResultsPanelInternals() {
  const filename = path.join(__dirname, '..', 'out', 'results-panel.js');
  const source = fs.readFileSync(filename, 'utf8') +
    '\nmodule.exports.__test = { chartColumnSignature, chartDecimalPlacesSettingValue, chartMaxSourceRowsSettingValue, chartPngBytesFromDataUrl, chartRangeIsZoomed, chartSelectionStorageKey, chartZoomMaxSampledPointsSettingValue, chartZoomMinSampledPointsSettingValue, columnarToXlsx, compatibleChartSelection, normalizePanelSettingUpdate, normalizeSavedChartSelection, panelSettingConfigKey, panelSizeSettingValue, renderResultsPanelHtml: extensionPath => KdbResultsPanel.prototype.html.call({}, { extensionPath }, { cspSource: "vscode-webview:", asWebviewUri: uri => String(uri && uri.fsPath || "") }) };';
  const testModule = new Module(filename, module);
  testModule.filename = filename;
  testModule.paths = Module._nodeModulePaths(path.dirname(filename));
  testModule.require = request => {
    if (request === 'vscode') {
      return mockVscode();
    }
    return Module._load(request, testModule, false);
  };
  testModule._compile(source, filename);
  return testModule.exports.__test;
}

function mockVscode() {
  return {
    ConfigurationTarget: { Global: 1 },
    ProgressLocation: { Notification: 15, Window: 10 },
    Uri: { file: fsPath => ({ fsPath }) },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    env: {},
    window: {},
    workspace: {},
  };
}

function listenTestServer(server, port, host) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeTestServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.on('error', reject);
    request.setTimeout(3000, () => {
      request.destroy(new Error(`GET timed out: ${url}`));
    });
  });
}

async function assertCompletesWithin(label, operation, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} did not complete within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

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
