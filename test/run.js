const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const JSZip = require('jszip');

const {
  deserializeQMessage,
  deserializeQPayload,
  QIpcReceiveBuffer,
  qValueRowsMaterialized,
  qValueToColumnarPanel,
  qValueToTabular,
  serializeTextQuery,
} = require('../out/ls/q-ipc');
const perfModule = require('../out/perf');
const queriesModule = require('../out/ls/queries');
const { currentQBlock, selectedTextOrCurrentBlock, selectedTextOrCurrentLine } = require('../out/q-text');
const {
  allCellsRange,
  applyColumnarRowOrder,
  columnarToCellWindow,
  compareColumnarCellText,
  exportShape,
  filterColumnarPanelResult,
  isCellInRange,
  normalizeCellRange,
  rowsToColumnarPanelResult,
  rowsToCellWindow,
  rowsToCsv,
  rowsToHtml,
  rowsToJson,
  rowsToNdjson,
  rowsToTextFormat,
  rowsToTsv,
  rowIndexColumnName,
  sortedColumnarRowOrder,
  validateXlsxSheetLimits,
  visibleIndexRange,
} = require('../out/kdb-results');
const KdbDriver = require('../out/ls/driver').default;
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

  const qScript = '.data.gateway:{[query;db]\n  neg[gatewayHandle](`.gw.asyncExec;query;db)\n}\n\nselect from trade';
  assert.strictEqual(currentQBlock(qScript, 1), '.data.gateway:{[query;db]\n  neg[gatewayHandle](`.gw.asyncExec;query;db)\n}');
  assert.strictEqual(currentQBlock(qScript, 4), 'select from trade');
  assert.strictEqual(selectedTextOrCurrentBlock(qScript, '1+1', 0), '1+1');
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
    '#,note,size,meta\n1,"line\nbreak",100,"{""venue"":""lit""}"\n2,,200,"[1,2]"'
  );
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
      [{ sym: 'A&B', note: '<tag "x" \'' }],
      ['sym', 'note'],
      { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 }
    ),
    '<table><thead><tr><th>sym</th><th>note</th></tr></thead><tbody><tr><td>A&amp;B</td><td>&lt;tag &quot;x&quot; &#39;</td></tr></tbody></table>'
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
  assert.strictEqual(rowsToTextFormat(exportRows, exportColumns, exportRange, 'ndjson'), rowsToNdjson(exportRows, exportColumns, exportRange));
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

  const resultsPanelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'results-panel.ts'), 'utf8');
  const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const kdbResultsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'kdb-results.ts'), 'utf8');
  const perfSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'perf.ts'), 'utf8');
  const readmeSource = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const packageSource = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
  const commandTitle = commandId => packageJson.contributes.commands.find(command => command.command === commandId).title;
  assert.strictEqual(resultsPanelSource.includes('innerHTML'), false, 'kdb results panel must not render grid cells via innerHTML');
  assert.strictEqual(resultsPanelSource.includes(' style="'), false, 'kdb results panel must not rely on inline style attributes for virtual grid positioning');
  assert.strictEqual(resultsPanelSource.includes('createElement'), true, 'kdb results panel should create positioned grid cells as DOM nodes');
  assert.strictEqual(resultsPanelSource.includes('const MAX_SCROLL_PIXELS = 24000000;'), true);
  assert.strictEqual(resultsPanelSource.includes('function scrollState(physicalScrollTop, viewportHeight, rowCount, currentLayout)'), true);
  assert.strictEqual(resultsPanelSource.includes('const physicalContentHeight = Math.min(virtualContentHeight, MAX_SCROLL_PIXELS);'), true);
  assert.strictEqual(resultsPanelSource.includes('physicalTop * (virtualScrollableHeight / physicalScrollableHeight)'), true);
  assert.strictEqual(resultsPanelSource.includes('function physicalScrollTopForVirtual(state, virtualTop)'), true);
  assert.strictEqual(resultsPanelSource.includes('target * (state.physicalScrollableHeight / state.virtualScrollableHeight)'), true);
  assert.strictEqual(resultsPanelSource.includes("canvas.style.height = state.canvasHeight + 'px';"), true);
  assert.strictEqual(resultsPanelSource.includes('const rows = visibleRange(state.rowOffset'), true);
  assert.strictEqual(resultsPanelSource.includes('rowElement.style.top = renderedRowTop(row, state, layout)'), true);
  assert.strictEqual(resultsPanelSource.includes('rowElement.style.top = (layout.headerHeight + row * layout.rowHeight)'), false);
  assert.deepStrictEqual(htmlSelectOptions(resultsPanelSource, 'copyFormat'), ['csv', 'tsv', 'json', 'ndjson', 'html']);
  assert.deepStrictEqual(htmlSelectOptions(resultsPanelSource, 'exportFormat'), ['csv', 'xlsx', 'tsv', 'json', 'ndjson', 'html']);
  assert.strictEqual(/parquet/i.test([resultsPanelSource, kdbResultsSource, readmeSource, packageSource].join('\n')), false);
  assert.strictEqual(packageJson.contributes.commands.some(command => /Run q Block|Run block/.test(command.title)), false);
  assert.strictEqual(commandTitle('kdb-sqltools.runFile'), 'Run q Script');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrBlock'), 'Run Selection');
  assert.strictEqual(commandTitle('kdb-sqltools.runFileInSqltools'), 'Run q Script in SQLTools Results');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrBlockInSqltools'), 'Run Selection in SQLTools Results');
  assert.strictEqual(commandTitle('kdb-sqltools.runFileInKdbPanel'), 'Run q Script in kdb Panel');
  assert.strictEqual(commandTitle('kdb-sqltools.runSelectionOrBlockInKdbPanel'), 'Run Selection in kdb Panel');
  assert.strictEqual(/function textExportFormat[\s\S]*return 'csv';/.test(resultsPanelSource), true);
  assert.strictEqual(/function exportFormat[\s\S]*return 'csv';/.test(resultsPanelSource), true);
  assert.strictEqual(resultsPanelSource.includes('sheetXml(result, range, includeHeaders, includeRowIndex)'), true);
  assert.strictEqual(resultsPanelSource.includes('headers.push(cellValueToText(rowIndexColumnName(result.columns, range)))'), true);
  assert.strictEqual(resultsPanelSource.includes('LARGE_RESULT_WARNING_CELL_THRESHOLD'), true);
  assert.strictEqual(resultsPanelSource.includes('resultSizeGuardrailMessage(result.table.rowCount, result.table.columns.length)'), true);
  assert.strictEqual(resultsPanelSource.includes('COPY_EXPORT_CONFIRM_CELL_THRESHOLD'), true);
  assert.strictEqual(resultsPanelSource.includes('largeCopyExportConfirmationMessage'), true);
  assert.strictEqual(resultsPanelSource.includes("showWarningMessage(message, 'Continue', 'Cancel')"), true);
  assert.strictEqual(resultsPanelSource.includes('validateXlsxSheetLimits(clamped, { includeHeaders, includeRowIndex })'), true);
  assert.strictEqual(kdbResultsSource.includes('XLSX_MAX_ROWS = 1048576'), true);
  assert.strictEqual(kdbResultsSource.includes('XLSX_MAX_COLUMNS = 16384'), true);
  assert.strictEqual(extensionSource.includes('driver.query(text, {})'), false, 'kdbPanel execution must not use row-object SQLTools driver.query');
  assert.strictEqual(extensionSource.includes('client.query(text)'), true, 'kdbPanel execution should query IPC directly');
  const resultSettings = packageJson.contributes.configuration.properties;
  assert.strictEqual(resultSettings['kdb-sqltools.results.target'].default, 'kdbPanel');
  assert.strictEqual(resultSettings['kdb-sqltools.performance.trace'].type, 'boolean');
  assert.strictEqual(resultSettings['kdb-sqltools.performance.trace'].default, false);
  assert.strictEqual(/extension host console/i.test(resultSettings['kdb-sqltools.performance.trace'].description), true);
  assert.deepStrictEqual(resultSettings['kdb-sqltools.results.density'].enum, ['compact', 'standard', 'comfortable']);
  assert.strictEqual(resultSettings['kdb-sqltools.results.showRowIndex'].type, 'boolean');
  assert.strictEqual(resultSettings['kdb-sqltools.results.showRowIndex'].default, true);
  assert.strictEqual(resultSettings['kdb-sqltools.results.includeHeaders'].type, 'boolean');
  assert.strictEqual(resultSettings['kdb-sqltools.results.includeHeaders'].default, true);
  assert.strictEqual(resultSettings['kdb-sqltools.results.includeRowIndex'].type, 'boolean');
  assert.strictEqual(resultSettings['kdb-sqltools.results.includeRowIndex'].default, true);
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
  assert.strictEqual(resultsPanelSource.includes('vscode.ConfigurationTarget.Global'), true);
  const numberSettingUpdateSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function numberSettingUpdate'),
    resultsPanelSource.indexOf('function densitySettingUpdate')
  );
  assert.strictEqual(numberSettingUpdateSource.includes('Math.min(Math.max(Math.floor(number), min), max)'), true);
  assert.strictEqual(numberSettingUpdateSource.includes('integer >= min && integer <= max'), false);
  assert.strictEqual(resultsPanelSource.includes('Object.prototype.hasOwnProperty.call(RESULT_SETTING_UPDATE_ALLOWLIST, key)'), true);
  const resultsPanelInternals = loadResultsPanelInternals();
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('cellWidth', '1000.9'), { key: 'cellWidth', value: 600 });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('rowHeight', 19), { key: 'rowHeight', value: 20 });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('fontSize', 'abc'), null);
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('density', 'compact'), { key: 'density', value: 'compact' });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('density', 'spacious'), null);
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('includeHeaders', false), { key: 'includeHeaders', value: false });
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('includeHeaders', 'false'), null);
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('constructor', 1), null);
  assert.deepStrictEqual(resultsPanelInternals.normalizePanelSettingUpdate('__proto__', true), null);
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
  assert.strictEqual(resultsPanelSource.includes('const requestVersion = integerOrNull(version);'), true);
  assert.strictEqual(resultsPanelSource.includes('await this.exportRange(requestVersion, clamped, format, includeHeaders, includeRowIndex)'), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'sortSkipped', version: requestVersion"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'copySkipped', version: requestVersion"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'exportSkipped', version: requestVersion"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'copied', version: requestVersion"), true);
  assert.strictEqual(resultsPanelSource.includes("type: 'exported', version: requestVersion"), true);
  assert.strictEqual(resultsPanelSource.includes('private isCurrentVersion(version: number): boolean'), true);
  assert.strictEqual(resultsPanelSource.includes('function isCurrentVersionMessage(msg)'), true);
  assert.strictEqual(resultsPanelSource.includes("msg.type === 'copied' && isCurrentVersionMessage(msg)"), true);
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
  assert.strictEqual(
    resultsPanelSource.includes("value.replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F&<>\"']/g"),
    true
  );
  assert.strictEqual(resultsPanelSource.includes('layout.showRowIndex'), true);
  assert.strictEqual(resultsPanelSource.includes('settings.showRowIndex ? INDEX_WIDTH : 0'), true);
  assert.strictEqual(kdbResultsSource.includes('filterColumnarPanelResult'), true);
  assert.strictEqual(resultsPanelSource.includes('hiddenColumnNames'), true);
  assert.strictEqual(resultsPanelSource.includes('private hiddenColumnSchema'), true);
  assert.strictEqual(resultsPanelSource.includes('hiddenColumnNamesForNewResult(result.table.columns)'), true);
  assert.strictEqual(resultsPanelSource.includes('sameColumnNames(this.hiddenColumnSchema, columns)'), true);
  assert.strictEqual(resultsPanelSource.includes('At least one column must stay visible'), true);
  assert.strictEqual(readmeSource.includes('only when the full column list matches'), true);
  assert.strictEqual(resultsPanelSource.includes("message.type === 'hideColumn'"), true);
  assert.strictEqual(resultsPanelSource.includes("message.type === 'showColumn'"), true);
  assert.strictEqual(resultsPanelSource.includes("message.type === 'resetHiddenColumns'"), true);
  assert.strictEqual(packageSource.includes('hiddenColumn'), false, 'hidden columns must not be globally persisted');
  assert.deepStrictEqual(htmlSelectOptions(resultsPanelSource, 'interactionMode'), ['select', 'sort']);
  assert.ok(
    resultsPanelSource.indexOf('<option value="select">Select</option>') < resultsPanelSource.indexOf('<option value="sort">Sort</option>'),
    'header mode must default to Select'
  );
  const visibleTableSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('private visibleTable'),
    resultsPanelSource.indexOf('private visibleSortState')
  );
  assert.strictEqual(visibleTableSource.includes('applyColumnarRowOrder(table, this.rowOrder)'), true);
  const sortColumnSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('private async sortColumn'),
    resultsPanelSource.indexOf('private async copyRange')
  );
  assert.strictEqual(sortColumnSource.includes('const table = this.baseVisibleTable();'), true);
  assert.strictEqual(sortColumnSource.includes('this.rowOrder = sortedRowOrder;'), true);
  assert.strictEqual(sortColumnSource.includes('sortedColumnarRowOrder(table, columnIndex, nextSort.direction)'), true);
  assert.strictEqual(sortColumnSource.includes('perfSpan(\'results-panel.sort\''), true);
  assert.strictEqual(sortColumnSource.includes('SORT_CONFIRM_ROW_THRESHOLD'), true);
  const sortHelperSource = kdbResultsSource.slice(
    kdbResultsSource.indexOf('export function sortedColumnarRowOrder'),
    kdbResultsSource.indexOf('export function compareColumnarCellText')
  );
  assert.strictEqual(sortHelperSource.includes('result.cellText(rowIndex, columnIndex)'), true);
  assert.strictEqual(sortHelperSource.includes('RowValue'), false, 'sort must not materialize row objects');
  const columnMouseSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('function onColumnMouseDown'),
    resultsPanelSource.indexOf('function onColumnMouseEnter')
  );
  assert.strictEqual(columnMouseSource.includes("if (headerMode() === 'sort')"), true);
  assert.strictEqual(columnMouseSource.includes("type: 'sortColumn'"), true);
  assert.ok(
    columnMouseSource.indexOf("type: 'sortColumn'") < columnMouseSource.indexOf("dragging = true"),
    'header click sorting must require Sort mode before column selection starts'
  );
  const postSliceSource = resultsPanelSource.slice(
    resultsPanelSource.indexOf('private postSlice'),
    resultsPanelSource.indexOf('private async copyRange')
  );
  assert.strictEqual(postSliceSource.includes('const table = this.visibleTable();'), true);
  assert.strictEqual(postSliceSource.includes('table.cellWindow(rowRange, columnRange)'), true);
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
  assert.strictEqual(searchRowsSource.includes('table.cellText(rowIndex, columnIndex)'), true);
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
  const longColumnar = qValueToColumnarPanel(deserializeQPayload(longVector([9007199254740993n, -9007199254740993n])));
  assert.deepStrictEqual(longColumnar.result.columns, ['index', 'value']);
  assert.strictEqual(longColumnar.result.rowCount, 2);
  assert.strictEqual(longColumnar.rowsMaterialized, false);
  assert.deepStrictEqual(longColumnar.result.cellWindow({ start: 0, end: 1 }, { start: 0, end: 1 }).cells, [
    ['0', '9007199254740993'],
    ['1', '-9007199254740993'],
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
    '\nmodule.exports.__test = { columnarToXlsx, normalizePanelSettingUpdate };';
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
    ViewColumn: { Beside: 2 },
    env: {},
    window: {},
    workspace: {},
  };
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
