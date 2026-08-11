const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { ContextValue } = require('@sqltools/types');
const { MockQServer } = require('../mock-q-ipc');
const KdbDriver = require('../../../out/ls/driver').default;
const { createColumnarPanelResult } = require('../../../out/kdb-results');
const { KdbResultsPanel } = require('../../../out/results-panel');
const { publisher, name } = require('../../../package.json');

const VISUAL_ENABLED = process.env.KDB_SQLTOOLS_E2E_VISUAL === '1';
const VISUAL_CONTROL_DIR = process.env.KDB_SQLTOOLS_E2E_VISUAL_CONTROL_DIR || '';
const GRID_FIXTURE_PATH = path.resolve(__dirname, '../workspace/grid-acceptance.q');
const GRID_PHASE_ONE_QUERY = 'select from gridAcceptancePhaseOne';
const GRID_RENAMED_QUERY = 'select from gridAcceptanceRenamed';
const GRID_RELOADED_QUERY = 'select from gridAcceptanceReloaded';
const GRID_PHASE_ONE_HEADERS = ['firstSource', 'arrayPayload', 'laterSource', 'tail'];
const GRID_RENAMED_HEADERS = ['renamedZero', 'differentPayload', 'renamedLater', 'extraFlag'];
const GRID_RELOADED_HEADERS = ['afterReloadZero', 'afterReloadPayload', 'afterReloadLater', 'afterReloadTail'];
const GRID_POSITION_KEYS = ['0', '2'];
const GRID_ROW_COUNT = 240;
const GRID_TIMEOUT_MS = 180000;
const POLL_MS = 200;
const GRID_COLUMN_WIDTH_CHECKPOINTS = [
  'reset-before',
  'reset-after',
  'cell-width-before',
  'cell-width-after',
  'density-before',
  'density-after',
];
const GRID_CONNECTION_ID = 'kdb-grid-persistence-e2e';
const GRID_CONNECTION_NAME = 'KDB grid persistence E2E';
const GRID_RESULT_SETTING_SECTION = 'kdb-sqltools.results';
const GRID_DETERMINISTIC_SETTINGS = [
  { section: GRID_RESULT_SETTING_SECTION, key: 'autoFitColumns', value: false },
  { section: GRID_RESULT_SETTING_SECTION, key: 'autoFitMode', value: 'wholeResult' },
  { section: GRID_RESULT_SETTING_SECTION, key: 'columnWidths', value: {} },
  { section: GRID_RESULT_SETTING_SECTION, key: 'density', value: 'standard' },
  { section: GRID_RESULT_SETTING_SECTION, key: 'standard.cellWidth', value: 160 },
  { section: GRID_RESULT_SETTING_SECTION, key: 'standard.rowHeight', value: 28 },
  { section: GRID_RESULT_SETTING_SECTION, key: 'standard.fontSize', value: 0 },
  { section: GRID_RESULT_SETTING_SECTION, key: 'compact.cellWidth', value: 140 },
  { section: GRID_RESULT_SETTING_SECTION, key: 'compact.rowHeight', value: 24 },
  { section: GRID_RESULT_SETTING_SECTION, key: 'compact.fontSize', value: 0 },
  { section: GRID_RESULT_SETTING_SECTION, key: 'comfortable.cellWidth', value: 180 },
  { section: GRID_RESULT_SETTING_SECTION, key: 'comfortable.rowHeight', value: 32 },
  { section: GRID_RESULT_SETTING_SECTION, key: 'comfortable.fontSize', value: 0 },
  { section: GRID_RESULT_SETTING_SECTION, key: 'kdbPanel.arrayDisplayFormat', value: 'commaSpace' },
];
const MUTATED_GLOBAL_SETTINGS = [
  { section: 'sqltools', key: 'connections' },
  ...GRID_DETERMINISTIC_SETTINGS.map(({ section, key }) => ({ section, key })),
];

const gridControlPath = fileName => path.join(VISUAL_CONTROL_DIR, fileName);
const reloadMarkerPath = VISUAL_CONTROL_DIR
  ? gridControlPath('grid-reload-marker.json')
  : '';
const reloadMarker = VISUAL_ENABLED && reloadMarkerPath
  ? readJsonIfPresent(reloadMarkerPath)
  : null;

if (reloadMarker) {
  registerPostReloadGridSuite(reloadMarker);
} else {
  registerInitialSuite();
}

function registerInitialSuite() {
  suite('kdb-sqltools VS Code E2E', function () {
    this.timeout(60000);

    let server;

    setup(async () => {
      server = new MockQServer();
      await server.start();
    });

    teardown(async () => {
      if (server) {
        await server.stop();
        server = null;
      }
    });

    test('activates and registers with the real SQLTools extension', async function () {
      if (process.env.KDB_SQLTOOLS_E2E_SQLTOOLS_INSTALLED !== '1') {
        this.skip();
      }

      const sqltools = vscode.extensions.getExtension('mtxr.sqltools');
      assert.ok(sqltools, 'expected mtxr.sqltools to be installed in the VS Code test host');

      const extension = vscode.extensions.getExtension(`${publisher}.${name}`);
      assert.ok(extension, 'expected this extension to be available in the VS Code test host');

      const api = await extension.activate();
      assert.ok(api, 'extension activation should return a SQLTools driver API');
      assert.ok(api.driverAliases.some(alias => alias.value === 'KDB'), 'KDB alias should be registered');
      const commands = await vscode.commands.getCommands(true);
      assert.ok(
        commands.includes('kdb-sqltools.selectKdbPanelQueryConnection'),
        'expected the kdb panel session selector command to be registered in the Extension Host'
      );
    });

    test('opens, tests, queries, and reads metadata through TCP q IPC', async () => {
      const driver = createDriver(server.port);

      try {
        await driver.testConnection();
        assert.ok(server.queries.includes('1+1'), 'testConnection should execute 1+1 through IPC');

        const queryResults = await driver.query('select from trade');
        assert.strictEqual(queryResults.length, 1);
        assert.strictEqual(queryResults[0].error, undefined);
        assert.deepStrictEqual(queryResults[0].cols, ['sym', 'size', 'price']);
        assert.deepStrictEqual(queryResults[0].results, [
          { sym: 'AAPL', size: 100, price: 123.45 },
          { sym: 'MSFT', size: 250, price: 234.56 },
        ]);

        const connectionItem = {
          label: 'mock q',
          type: ContextValue.CONNECTION,
          database: '.',
          schema: '.',
        };
        const groups = await driver.getChildrenForItem({ item: connectionItem });
        const tablesGroup = groups.find(item => item.label === 'Tables');
        assert.ok(tablesGroup, 'expected a Tables explorer group');

        const tables = await driver.getChildrenForItem({ item: tablesGroup, parent: connectionItem });
        assert.deepStrictEqual(tables.map(table => table.label), ['trade', 'quote']);

        const columnGroups = await driver.getChildrenForItem({ item: tables[0], parent: tablesGroup });
        assert.strictEqual(columnGroups.length, 1);
        assert.strictEqual(columnGroups[0].label, 'Columns');

        const columns = await driver.getChildrenForItem({ item: columnGroups[0], parent: tables[0] });
        assert.deepStrictEqual(columns.map(column => column.label), ['sym', 'size', 'price']);
        assert.deepStrictEqual(columns.map(column => column.dataType), ['symbol', 'int', 'float']);
      } finally {
        await driver.close();
      }
    });

    test('renders zoom, button/Shift pan, and nested zoom from the full source', async function () {
      if (!VISUAL_ENABLED) {
        this.skip();
      }
      this.timeout(90000);

      const extension = vscode.extensions.getExtension(`${publisher}.${name}`);
      assert.ok(extension, 'expected this extension to be available in the VS Code test host');
      await extension.activate();

      const savedState = new Map();
      const context = {
        extensionPath: extension.extensionPath,
        globalState: {
          get(key, fallback) {
            return savedState.has(key) ? savedState.get(key) : fallback;
          },
          async update(key, value) {
            if (value === undefined) {
              savedState.delete(key);
            } else {
              savedState.set(key, value);
            }
          },
        },
      };
      const table = createColumnarPanelResult(
        ['x', 'y', 'open', 'high', 'low', 'close'],
        12000,
        (rowIndex, columnIndex) => {
          if (columnIndex === 0) {
            return rowIndex;
          }
          if (columnIndex === 1) {
            return Math.sin(rowIndex / 37) * 100 + (rowIndex % 211);
          }
          const open = 100 + Math.sin(rowIndex / 29) * 8 + rowIndex / 1_000;
          if (columnIndex === 2) {
            return open;
          }
          if (columnIndex === 3) {
            return open + 3 + rowIndex % 4;
          }
          if (columnIndex === 4) {
            return open - 2 - rowIndex % 3;
          }
          return open + Math.sin(rowIndex / 11) * 2;
        }
      );
      const chartPanel = KdbResultsPanel.showResult(context, {
        query: 'visual nested zoom acceptance',
        connectionName: 'deterministic E2E source',
        elapsedMs: 1,
        messages: [],
        table,
      }, 'new', { autoChart: true });
      installVisualChartExportHook(chartPanel);

      const result = await waitForVisualResult(
        gridControlPath('result.json'),
        75000
      );
      assert.strictEqual(result.ok, true, result.error || 'visual controller failed');
      assert.strictEqual(result.initial.sourceRowCount, 12000);
      assert.strictEqual(result.first.sourceRowCount, 12000);
      assert.strictEqual(result.buttonPan.sourceRowCount, 12000);
      assert.strictEqual(result.shiftPan.sourceRowCount, 12000);
      assert.strictEqual(result.second.sourceRowCount, 12000);
      assert.ok(result.first.requestId > result.initial.requestId);
      assert.strictEqual(result.buttonPan.requestId, result.first.requestId + 1);
      assert.strictEqual(result.shiftPan.requestId, result.buttonPan.requestId + 1);
      assert.ok(result.second.requestId > result.first.requestId);
      assert.ok(result.second.requestId > result.shiftPan.requestId);
      const firstSpan = result.first.requestedRange.max - result.first.requestedRange.min;
      const buttonPanSpan = result.buttonPan.requestedRange.max - result.buttonPan.requestedRange.min;
      const shiftPanSpan = result.shiftPan.requestedRange.max - result.shiftPan.requestedRange.min;
      assert.ok(Math.abs(buttonPanSpan - firstSpan) <= Math.max(1e-7, Math.abs(firstSpan) * 1e-9));
      assert.ok(Math.abs(shiftPanSpan - buttonPanSpan) <= Math.max(1e-7, Math.abs(buttonPanSpan) * 1e-9));
      assert.ok(result.buttonPan.requestedRange.min > result.first.requestedRange.min);
      assert.ok(result.shiftPan.requestedRange.min < result.buttonPan.requestedRange.min);
      assert.ok(result.second.eligibleRowCount >= 3000);
      assert.deepStrictEqual(
        result.families.map(family => family.chartType),
        ['line', 'scatter', 'step', 'bar', 'box', 'candlestick']
      );
      assert.strictEqual(new Set(result.families.map(family => family.screenshotSha256)).size, 6);
      result.families.forEach(family => {
        assert.strictEqual(family.sourceRowCount, 12000);
        assert.match(family.screenshotSha256, /^[0-9a-f]{64}$/);
        assert.ok(family.screenshotByteLength >= 1_000);
        assert.ok(family.screenshotWidth > 0 && family.screenshotHeight > 0);
      });
      assert.match(
        result.families.find(family => family.chartType === 'bar').status,
        /Dense bar clusters too narrow to distinguish were skipped/
      );
      assert.strictEqual(result.dirtyControlExport.png, true);
      assert.strictEqual(result.dirtyControlExport.productionGuardAccepted, true);
      const savedSelections = Array.from(savedState.entries())
        .filter(([key]) => key.startsWith('kdb-sqltools.results.kdbPanel.chartSelection.v1.'))
        .map(([, value]) => value);
      assert.strictEqual(savedSelections.length, 1);
      assert.strictEqual(savedSelections[0].chartType, 'candlestick');
      console.log(`Visual nested zoom evidence: ${JSON.stringify(result)}`);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    test('persists real grid widths by source position through a VS Code reload', async function () {
      if (!VISUAL_ENABLED) {
        this.skip();
      }
      this.timeout(GRID_TIMEOUT_MS);

      let settingsSnapshot;
      let autoFitProbe;
      let reloadPrepared = false;
      try {
        removeGridPhaseControlFiles();
        const extension = vscode.extensions.getExtension(`${publisher}.${name}`);
        assert.ok(extension, 'expected this extension to be available in the VS Code test host');
        await extension.activate();

        settingsSnapshot = snapshotGlobalSettings(MUTATED_GLOBAL_SETTINGS);
        await configurePhaseOneGlobalSettings(server.port);
        autoFitProbe = instrumentWholeResultAutoFitRequests();

        const editor = await openGridFixture(GRID_PHASE_ONE_QUERY);
        await vscode.commands.executeCommand('kdb-sqltools.runFileInNewKdbPanel');
        assertServerSawQuery(server, GRID_PHASE_ONE_QUERY);

        const widthResult = await waitForJson(
          gridControlPath('grid-widths.json'),
          GRID_TIMEOUT_MS,
          'initial manual grid widths'
        );
        assertControllerResult(widthResult, 'initial manual grid widths');
        assertGridIdentity(widthResult, GRID_PHASE_ONE_QUERY, GRID_PHASE_ONE_HEADERS);
        assert.strictEqual(widthResult.autoFitChecked, false, 'Auto-fit checkbox must render unchecked');
        assert.strictEqual(widthResult.autoFitMode, 'wholeResult');
        assert.strictEqual(widthResult.allRenderedCellsMatch, true);
        assert.strictEqual(widthResult.initialWidthsStable, true);
        assert.deepStrictEqual(
          {
            triState: widthResult.interactions.triState,
            jitterSort: widthResult.interactions.jitterSort,
            dragReorderWithoutSort: widthResult.interactions.dragReorderWithoutSort,
            keyboardSortAndReorder: widthResult.interactions.keyboardSortAndReorder,
            pointerKeyboardAndShiftSelection: widthResult.interactions.pointerKeyboardAndShiftSelection,
            nativeInput: widthResult.interactions.nativeInput,
            aria: widthResult.interactions.aria,
            absoluteRowParity: widthResult.interactions.absoluteRowParity,
          },
          {
            triState: true,
            jitterSort: true,
            dragReorderWithoutSort: true,
            keyboardSortAndReorder: true,
            pointerKeyboardAndShiftSelection: true,
            nativeInput: true,
            aria: true,
            absoluteRowParity: true,
          }
        );
        assert.ok(widthResult.interactions.oddRowBackground);
        assert.notStrictEqual(
          widthResult.interactions.oddRowBackground,
          widthResult.interactions.evenRowBackground
        );
        assert.strictEqual(
          widthResult.interactions.resizeDoubleClickReset.resetWidth,
          widthResult.interactions.resizeDoubleClickReset.fallbackWidth
        );

        const widthsByPosition = assertManualWidths(widthResult.widthsByPosition);
        await waitForConfigValue(
          GRID_RESULT_SETTING_SECTION,
          'columnWidths',
          widthsByPosition,
          'persisted phase-one manual widths'
        );
        assert.strictEqual(
          autoFitProbe.count,
          0,
          'unchecked auto-fit must not make a whole-result sizing request'
        );

        await setEditorQuery(editor, GRID_RENAMED_QUERY);
        await vscode.commands.executeCommand('kdb-sqltools.runFileInKdbPanelReplace');
        assertServerSawQuery(server, GRID_RENAMED_QUERY);

        const beforeReload = await waitForJson(
          gridControlPath('grid-before-reload-result.json'),
          GRID_TIMEOUT_MS,
          'renamed-schema positional widths'
        );
        assertControllerResult(beforeReload, 'renamed-schema positional widths');
        assertGridIdentity(beforeReload, GRID_RENAMED_QUERY, GRID_RENAMED_HEADERS);
        assert.strictEqual(beforeReload.autoFitChecked, false);
        assert.strictEqual(beforeReload.autoFitMode, 'wholeResult');
        assert.strictEqual(beforeReload.allRenderedCellsMatch, true);
        assert.strictEqual(beforeReload.positionalPersistence, true);
        assert.deepStrictEqual(normalizeWidthMap(beforeReload.widthsByPosition), widthsByPosition);
        assert.strictEqual(
          autoFitProbe.count,
          0,
          'unchecked auto-fit must remain request-free after replacing the result'
        );

        autoFitProbe.restore();
        autoFitProbe = null;
        await waitForConfigValue(
          GRID_RESULT_SETTING_SECTION,
          'columnWidths',
          widthsByPosition,
          'manual widths before window reload'
        );
        const commands = await vscode.commands.getCommands(true);
        assert.ok(
          commands.includes('workbench.action.reloadWindow'),
          'the real VS Code reload-window command must be registered'
        );
        const reloadMarkerValue = {
          version: 1,
          phaseOneComplete: true,
          reloadCommand: 'workbench.action.reloadWindow',
          widthsByPosition,
          settingsSnapshot,
          connectionId: GRID_CONNECTION_ID,
          fixturePath: GRID_FIXTURE_PATH,
        };
        console.log(`Visual grid pre-reload evidence: ${JSON.stringify({
          widthResult,
          beforeReload,
          wholeResultRequestCount: 0,
          persistedColumnWidths: widthsByPosition,
        })}`);

        writeJsonAtomic(reloadMarkerPath, {
          ...reloadMarkerValue,
          reloadCommandIssued: true,
        });
        reloadPrepared = true;
        try {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        } catch (error) {
          if (!isReloadCancellation(error)) {
            reloadPrepared = false;
            removeFileIfPresent(reloadMarkerPath);
            throw error;
          }
          writeJsonAtomic(reloadMarkerPath, {
            ...reloadMarkerValue,
            reloadCommandIssued: true,
            reloadPromiseCancellation: {
              name: error && error.name,
              message: error && error.message,
            },
          });
          throw error;
        }
        await new Promise(() => {});
      } catch (error) {
        if (autoFitProbe) {
          autoFitProbe.restore();
        }
        if (!reloadPrepared) {
          await cleanupFailedPhaseOne(settingsSnapshot);
        }
        throw error;
      }
    });
  });
}

function registerPostReloadGridSuite(marker) {
  suite('kdb-sqltools VS Code E2E post-reload grid persistence', function () {
    this.timeout(GRID_TIMEOUT_MS);

    let server;

    setup(async () => {
      server = new MockQServer();
      await server.start();
    });

    teardown(async () => {
      if (server) {
        await server.stop();
        server = null;
      }
    });

    test('restores real positional widths and verifies grid sizing controls after reload', async () => {
      this.timeout(GRID_TIMEOUT_MS);

      try {
        validateReloadMarker(marker);
        const extension = vscode.extensions.getExtension(`${publisher}.${name}`);
        assert.ok(extension, 'expected this extension to be available in the reloaded VS Code test host');
        await extension.activate();

        const persistedBeforeOpen = normalizeWidthMap(
          vscode.workspace.getConfiguration(GRID_RESULT_SETTING_SECTION).get('columnWidths', {})
        );
        assert.deepStrictEqual(
          persistedBeforeOpen,
          normalizeWidthMap(marker.widthsByPosition),
          'global positional widths must survive reload before any result panel opens'
        );

        const reloadedConnection = await updateGridConnectionPort(server.port, marker.connectionId);
        const editor = await openGridFixture(GRID_RELOADED_QUERY);
        await vscode.commands.executeCommand('kdb-sqltools.runFileInNewKdbPanel');
        assertServerSawQuery(server, GRID_RELOADED_QUERY);
        writeJsonAtomic(gridControlPath('grid-after-reload-ready.json'), {
          ok: true,
          query: GRID_RELOADED_QUERY,
          connection: {
            id: reloadedConnection.id,
            name: reloadedConnection.name,
            port: reloadedConnection.port,
          },
          widthsByPosition: persistedBeforeOpen,
        });

        const columnWidthCheckpoints = await verifyColumnWidthCheckpoints();
        const result = await waitForJson(
          gridControlPath('grid-after-reload-result.json'),
          GRID_TIMEOUT_MS,
          'post-reload grid acceptance'
        );
        assertControllerResult(result, 'post-reload grid acceptance');
        assertPostReloadGridResult(result, marker.widthsByPosition);
        assert.deepStrictEqual(columnWidthCheckpoints['reset-before'], normalizeWidthMap(marker.widthsByPosition));
        assert.deepStrictEqual(columnWidthCheckpoints['reset-after'], {});
        assert.deepStrictEqual(columnWidthCheckpoints['cell-width-after'], {});
        assert.deepStrictEqual(columnWidthCheckpoints['density-after'], {});
        await waitForConfigValue(
          GRID_RESULT_SETTING_SECTION,
          'columnWidths',
          {},
          'cleared positional widths after grid reset'
        );
        assert.deepStrictEqual(normalizeWidthMap(result.finalColumnWidths), {});
        console.log(`Visual grid post-reload evidence: ${JSON.stringify({
          persistedBeforeOpen,
          result,
          finalColumnWidths: vscode.workspace
            .getConfiguration(GRID_RESULT_SETTING_SECTION)
            .get('columnWidths', {}),
        })}`);
      } finally {
        try {
          await restoreGlobalSettings(marker.settingsSnapshot);
          assertGlobalSettingsRestored(marker.settingsSnapshot);
        } finally {
          try {
            await revertGridFixtureAndCloseEditors();
            assert.strictEqual(
              normalizeQuery(fs.readFileSync(GRID_FIXTURE_PATH, 'utf8')),
              GRID_PHASE_ONE_QUERY,
              'grid q fixture must be restored after reload acceptance'
            );
          } finally {
            removeFileIfPresent(gridControlPath('grid-after-reload-ready.json'));
            removeFileIfPresent(reloadMarkerPath);
            removeColumnWidthCheckpointFiles();
          }
        }
      }
    });
  });
}

function createDriver(port) {
  return new KdbDriver({
    id: 'e2e-mock-q',
    name: 'E2E mock q',
    driver: 'KDB',
    server: '127.0.0.1',
    port,
    database: '.',
    username: '',
    password: '',
    connectionTimeout: 5,
    isConnected: false,
    isActive: false,
  }, async () => []);
}

async function waitForVisualResult(resultPath, timeoutMs) {
  return waitForJson(resultPath, timeoutMs, 'browser visual acceptance result');
}

function installVisualChartExportHook(panel) {
  const exportPath = gridControlPath('chart-dirty-control-export.json');
  const originalExportChartPng = panel.exportChartPng.bind(panel);
  const originalPost = panel.post.bind(panel);
  let pendingExportProbe;
  panel.post = message => {
    if (pendingExportProbe && message?.type === 'chartExportError' &&
      Number(message.version) === pendingExportProbe.version &&
      Number(message.requestId) === pendingExportProbe.requestId) {
      writeJsonAtomic(exportPath, {
        ...pendingExportProbe,
        activeRequestId: Number(panel.activeChartRequestId),
        productionGuardAccepted: true,
        responseType: message.type,
      });
      pendingExportProbe = undefined;
    }
    return originalPost(message);
  };
  panel.exportChartPng = async message => {
    pendingExportProbe = {
      version: Number(message.version),
      requestId: Number(message.requestId),
      png: typeof message.dataUrl === 'string' && message.dataUrl.startsWith('data:image/png;base64,'),
    };
    const notificationCloser = setInterval(() => {
      void vscode.commands.executeCommand('notifications.clearAll');
    }, 100);
    try {
      return await originalExportChartPng({
        ...message,
        // The real Chromium PNG is proven above. Substituting an invalid copy
        // after receipt avoids a native save dialog while still exercising the
        // production version/request guard and its chartExportError response.
        dataUrl: 'data:text/plain;base64,Zm9v',
      });
    } finally {
      clearInterval(notificationCloser);
    }
  };
}

async function waitForJson(resultPath, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(resultPath, 'utf8');
      if (text.trim()) {
        return JSON.parse(text);
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
      lastError = error;
    }
    await delay(POLL_MS);
  }
  throw new Error(
    `Timed out waiting for ${label} at ${resultPath}` +
    (lastError && lastError.code !== 'ENOENT' ? `: ${lastError.message}` : '')
  );
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

function removeGridPhaseControlFiles() {
  [
    'grid-widths.json',
    'grid-before-reload-result.json',
    'grid-reload-marker.json',
    'grid-after-reload-ready.json',
    'grid-after-reload-result.json',
  ].forEach(fileName => removeFileIfPresent(gridControlPath(fileName)));
  removeColumnWidthCheckpointFiles();
}

function removeColumnWidthCheckpointFiles() {
  GRID_COLUMN_WIDTH_CHECKPOINTS.forEach(checkpoint => {
    removeFileIfPresent(gridControlPath(`grid-column-widths-${checkpoint}.json`));
    removeFileIfPresent(gridControlPath(`grid-column-widths-${checkpoint}-ack.json`));
  });
}

function removeFileIfPresent(filePath) {
  if (!filePath) {
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function snapshotGlobalSettings(settings) {
  return settings.map(({ section, key }) => {
    const inspection = vscode.workspace.getConfiguration(section).inspect(key);
    const hadGlobalValue = !!inspection && inspection.globalValue !== undefined;
    return {
      section,
      key,
      hadGlobalValue,
      ...(hadGlobalValue ? { globalValue: cloneJsonValue(inspection.globalValue) } : {}),
    };
  });
}

async function restoreGlobalSettings(snapshot) {
  if (!Array.isArray(snapshot)) {
    return;
  }
  for (const entry of snapshot) {
    assert.ok(entry && typeof entry.section === 'string' && typeof entry.key === 'string');
    await vscode.workspace.getConfiguration(entry.section).update(
      entry.key,
      entry.hadGlobalValue ? cloneJsonValue(entry.globalValue) : undefined,
      vscode.ConfigurationTarget.Global
    );
  }
}

function assertGlobalSettingsRestored(snapshot) {
  if (!Array.isArray(snapshot)) {
    return;
  }
  for (const entry of snapshot) {
    const inspection = vscode.workspace.getConfiguration(entry.section).inspect(entry.key);
    const globalValue = inspection && inspection.globalValue;
    if (entry.hadGlobalValue) {
      assert.deepStrictEqual(
        globalValue,
        entry.globalValue,
        `expected restored global setting ${entry.section}.${entry.key}`
      );
    } else {
      assert.strictEqual(
        globalValue,
        undefined,
        `expected cleared global setting ${entry.section}.${entry.key}`
      );
    }
  }
}

async function configurePhaseOneGlobalSettings(port) {
  const connection = {
    id: GRID_CONNECTION_ID,
    name: GRID_CONNECTION_NAME,
    driver: 'KDB',
    server: '127.0.0.1',
    port,
    database: '.',
    username: '',
    password: '',
    connectionTimeout: 5,
    isConnected: false,
    isActive: false,
  };
  await vscode.workspace.getConfiguration('sqltools').update(
    'connections',
    [connection],
    vscode.ConfigurationTarget.Global
  );
  for (const setting of GRID_DETERMINISTIC_SETTINGS) {
    await vscode.workspace.getConfiguration(setting.section).update(
      setting.key,
      cloneJsonValue(setting.value),
      vscode.ConfigurationTarget.Global
    );
  }

  assert.deepStrictEqual(
    vscode.workspace.getConfiguration('sqltools').get('connections', []),
    [connection]
  );
  for (const setting of GRID_DETERMINISTIC_SETTINGS) {
    assert.deepStrictEqual(
      vscode.workspace.getConfiguration(setting.section).get(setting.key),
      setting.value,
      `expected deterministic global setting ${setting.section}.${setting.key}`
    );
  }
}

async function updateGridConnectionPort(port, expectedId) {
  const config = vscode.workspace.getConfiguration('sqltools');
  const connections = config.get('connections', []);
  assert.strictEqual(connections.length, 1, 'expected exactly one real SQLTools KDB E2E connection');
  assert.strictEqual(connections[0].id, expectedId);
  assert.strictEqual(connections[0].name, GRID_CONNECTION_NAME);
  const updated = { ...connections[0], port };
  await config.update('connections', [updated], vscode.ConfigurationTarget.Global);
  await waitForConfigValue(
    'sqltools',
    'connections',
    [updated],
    'reloaded TCP q server connection port'
  );
  return updated;
}

function instrumentWholeResultAutoFitRequests() {
  const original = KdbResultsPanel.prototype.postWholeResultAutoFit;
  assert.strictEqual(
    typeof original,
    'function',
    'expected the real KdbResultsPanel whole-result auto-fit handler'
  );
  let count = 0;
  let restored = false;
  KdbResultsPanel.prototype.postWholeResultAutoFit = async function (...args) {
    count += 1;
    return original.apply(this, args);
  };
  return {
    get count() {
      return count;
    },
    restore() {
      if (!restored) {
        KdbResultsPanel.prototype.postWholeResultAutoFit = original;
        restored = true;
      }
    },
  };
}

async function openGridFixture(query) {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(GRID_FIXTURE_PATH));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  await setEditorQuery(editor, query);
  return editor;
}

async function setEditorQuery(editor, query) {
  await vscode.window.showTextDocument(editor.document, {
    preview: false,
    viewColumn: editor.viewColumn,
  });
  const edit = new vscode.WorkspaceEdit();
  const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
  edit.replace(
    editor.document.uri,
    new vscode.Range(new vscode.Position(0, 0), lastLine.rangeIncludingLineBreak.end),
    `${query}\n`
  );
  assert.strictEqual(await vscode.workspace.applyEdit(edit), true, `failed to set q fixture to ${query}`);
  assert.strictEqual(normalizeQuery(editor.document.getText()), query);
}

async function revertGridFixtureAndCloseEditors() {
  const document = vscode.workspace.textDocuments.find(candidate => {
    return candidate.uri.fsPath === GRID_FIXTURE_PATH;
  });
  if (document && document.isDirty) {
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function cleanupFailedPhaseOne(settingsSnapshot) {
  try {
    await restoreGlobalSettings(settingsSnapshot);
  } finally {
    try {
      await revertGridFixtureAndCloseEditors();
    } finally {
      removeFileIfPresent(reloadMarkerPath);
    }
  }
}

function assertServerSawQuery(server, expectedQuery) {
  assert.ok(
    server.queries.some(query => normalizeQuery(query) === expectedQuery),
    `real TCP q server did not receive ${expectedQuery}; received ${JSON.stringify(server.queries)}`
  );
}

function assertControllerResult(result, label) {
  assert.ok(result && typeof result === 'object', `${label} must return JSON evidence`);
  assert.strictEqual(result.ok, true, result.error || `${label} controller failed`);
}

function assertGridIdentity(result, expectedQuery, expectedHeaders) {
  assert.strictEqual(normalizeQuery(result.query), expectedQuery);
  assert.deepStrictEqual(result.headers, expectedHeaders);
}

function assertManualWidths(value) {
  const widths = normalizeWidthMap(value);
  assert.deepStrictEqual(Object.keys(widths).sort(), GRID_POSITION_KEYS);
  GRID_POSITION_KEYS.forEach(key => {
    assert.ok(
      Number.isFinite(widths[key]) && widths[key] >= 80 && widths[key] <= 2000,
      `manual width ${key} must be a finite persisted grid width`
    );
  });
  assert.notStrictEqual(widths['0'], widths['2'], 'first and later columns must have distinct widths');
  return widths;
}

function assertPostReloadGridResult(result, expectedWidthsValue) {
  const expectedWidths = assertManualWidths(expectedWidthsValue);
  assertGridIdentity(result.reloaded, GRID_RELOADED_QUERY, GRID_RELOADED_HEADERS);
  assert.deepStrictEqual(normalizeWidthMap(result.reloaded.widthsByPosition), expectedWidths);
  assert.strictEqual(result.reloaded.allRenderedCellsMatch, true);

  const wholeResult = result.wholeResult;
  assert.ok(wholeResult && typeof wholeResult === 'object');
  assert.strictEqual(wholeResult.autoFitChecked, true);
  assert.strictEqual(wholeResult.autoFitMode, 'wholeResult');
  assert.strictEqual(wholeResult.offscreenRow, GRID_ROW_COUNT - 1);
  assert.strictEqual(wholeResult.offscreenValueDeterminedWidth, true);
  assert.strictEqual(wholeResult.widthsStable, true);
  assertWidthArray(wholeResult.beforeScrollWidths, GRID_RELOADED_HEADERS.length, 'whole-result widths before scroll');
  assertWidthArray(wholeResult.afterScrollWidths, GRID_RELOADED_HEADERS.length, 'whole-result widths after scroll');
  assert.deepStrictEqual(wholeResult.afterScrollWidths, wholeResult.beforeScrollWidths);

  const visibleRows = result.visibleRows;
  assert.ok(visibleRows && typeof visibleRows === 'object');
  assert.strictEqual(visibleRows.autoFitChecked, true);
  assert.strictEqual(visibleRows.autoFitMode, 'visibleRows');
  assert.strictEqual(visibleRows.adaptive, true);
  assertWidthArray(visibleRows.beforeScrollWidths, GRID_RELOADED_HEADERS.length, 'visible-row widths before scroll');
  assertWidthArray(visibleRows.afterScrollWidths, GRID_RELOADED_HEADERS.length, 'visible-row widths after scroll');
  assert.notDeepStrictEqual(visibleRows.afterScrollWidths, visibleRows.beforeScrollWidths);

  assertPresetEvidence(result.cellWidthPreset, GRID_RELOADED_HEADERS.length, 'Cell width');
  assertPresetEvidence(result.densityPreset, GRID_RELOADED_HEADERS.length, 'density');
  assert.strictEqual(result.densityPreset.density, 'comfortable');
  assert.strictEqual(result.densityPreset.cellWidth, 180);

  const reset = result.reset;
  assert.ok(reset && typeof reset === 'object');
  assert.strictEqual(reset.autoFitMode, 'wholeResult');
  assert.strictEqual(reset.columnWidthsCleared, true);
  assert.strictEqual(reset.recomputed, true);
  assert.strictEqual(reset.offscreenValueDeterminedWidth, true);
  assert.deepStrictEqual(normalizeWidthMap(reset.persistedBefore), expectedWidths);
  assert.deepStrictEqual(normalizeWidthMap(reset.persistedAfter), {});
  assert.deepStrictEqual(normalizeWidthMap(result.finalColumnWidths), {});
}

function assertPresetEvidence(evidence, columnCount, label) {
  assert.ok(evidence && typeof evidence === 'object', `${label} preset evidence is required`);
  assert.strictEqual(evidence.columnWidthsCleared, true);
  assert.strictEqual(evidence.allColumnsAffected, true);
  const expectedWidth = Number(
    evidence.value === undefined ? evidence.cellWidth : evidence.value
  );
  assert.ok(Number.isFinite(expectedWidth), `${label} preset must report its cell width`);
  assertWidthArray(evidence.widths, columnCount, `${label} preset widths`);
  evidence.widths.forEach(width => {
    assert.ok(
      Math.abs(width - expectedWidth) <= 1,
      `${label} preset width ${width} must match ${expectedWidth}`
    );
  });
  assert.notDeepStrictEqual(normalizeWidthMap(evidence.persistedBefore), {});
  assert.deepStrictEqual(normalizeWidthMap(evidence.persistedAfter), {});
}

function assertWidthArray(widths, columnCount, label) {
  assert.ok(Array.isArray(widths), `${label} must be an array`);
  assert.strictEqual(widths.length, columnCount, `${label} must cover every source column`);
  widths.forEach(width => assert.ok(Number.isFinite(width) && width > 0, `${label} contains ${width}`));
}

async function waitForConfigValue(section, key, expected, label) {
  const deadline = Date.now() + GRID_TIMEOUT_MS;
  let actual;
  while (Date.now() < deadline) {
    actual = vscode.workspace.getConfiguration(section).get(key);
    if (isDeepStrictEqual(actual, expected)) {
      return;
    }
    await delay(POLL_MS);
  }
  assert.deepStrictEqual(actual, expected, `timed out waiting for ${label}`);
}

async function verifyColumnWidthCheckpoints() {
  const evidence = {};
  for (const checkpoint of GRID_COLUMN_WIDTH_CHECKPOINTS) {
    const readyPath = gridControlPath(`grid-column-widths-${checkpoint}.json`);
    const ackPath = gridControlPath(`grid-column-widths-${checkpoint}-ack.json`);
    try {
      const request = await waitForJson(
        readyPath,
        GRID_TIMEOUT_MS,
        `${checkpoint} real global column-width checkpoint`
      );
      assertControllerResult(request, `${checkpoint} real global column-width checkpoint`);
      assert.strictEqual(request.checkpoint, checkpoint);
      const expected = normalizeWidthMap(request.expectedColumnWidths);
      await waitForConfigValue(
        GRID_RESULT_SETTING_SECTION,
        'columnWidths',
        expected,
        `${checkpoint} real global column widths`
      );
      const actual = normalizeWidthMap(
        vscode.workspace.getConfiguration(GRID_RESULT_SETTING_SECTION).get('columnWidths', {})
      );
      assert.deepStrictEqual(actual, expected);
      const expectedSettings = request.expectedSettings || {};
      const actualSettings = {};
      for (const [key, expectedValue] of Object.entries(expectedSettings)) {
        await waitForConfigValue(
          GRID_RESULT_SETTING_SECTION,
          key,
          expectedValue,
          `${checkpoint} real global ${key}`
        );
        actualSettings[key] = vscode.workspace
          .getConfiguration(GRID_RESULT_SETTING_SECTION)
          .get(key);
        assert.deepStrictEqual(actualSettings[key], expectedValue);
      }
      evidence[checkpoint] = actual;
      writeJsonAtomic(ackPath, {
        ok: true,
        checkpoint,
        columnWidths: actual,
        settings: actualSettings,
      });
    } catch (error) {
      writeJsonAtomic(ackPath, {
        ok: false,
        checkpoint,
        error: error && error.stack ? error.stack : String(error),
      });
      throw error;
    }
  }
  assert.notDeepStrictEqual(evidence['cell-width-before'], {});
  assert.notDeepStrictEqual(evidence['density-before'], {});
  return evidence;
}

function validateReloadMarker(marker) {
  assert.strictEqual(marker.version, 1);
  assert.strictEqual(marker.phaseOneComplete, true);
  assert.strictEqual(marker.reloadCommand, 'workbench.action.reloadWindow');
  assert.strictEqual(marker.reloadCommandIssued, true);
  if (marker.reloadPromiseCancellation) {
    assert.deepStrictEqual(marker.reloadPromiseCancellation, {
      name: 'Canceled',
      message: 'Canceled',
    });
  }
  assertManualWidths(marker.widthsByPosition);
  assert.ok(Array.isArray(marker.settingsSnapshot), 'reload marker must contain the global settings snapshot');
  assert.strictEqual(marker.connectionId, GRID_CONNECTION_ID);
  assert.strictEqual(marker.fixturePath, GRID_FIXTURE_PATH);
}

function isReloadCancellation(error) {
  return !!error && error.name === 'Canceled' && error.message === 'Canceled';
}

function normalizeWidthMap(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result;
  }
  Object.keys(value).sort((left, right) => Number(left) - Number(right)).forEach(key => {
    const width = Number(value[key]);
    if (Number.isFinite(width)) {
      result[String(Number(key))] = width;
    }
  });
  return result;
}

function normalizeQuery(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cloneJsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isDeepStrictEqual(actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    return true;
  } catch (_error) {
    return false;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
