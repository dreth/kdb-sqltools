const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const POLL_MS = 200;
const NATIVE_INPUT_ATTEMPTS = 3;
const NATIVE_INPUT_DELAY_MS = 30;
const NATIVE_RECEIPT_TIMEOUT_MS = 750;
const TARGET_TIMEOUT_MS = 60000;
const REFINEMENT_TIMEOUT_MS = 20000;
const GRID_TIMEOUT_MS = 90000;
const CONTROL_TIMEOUT_MS = 120000;
const GRID_PHASE_ONE_HEADERS = [
  'firstSource',
  'arrayPayload',
  'laterSource',
  'tail',
];
const GRID_RENAMED_HEADERS = [
  'renamedZero',
  'differentPayload',
  'renamedLater',
  'extraFlag',
];
const GRID_RELOADED_HEADERS = [
  'afterReloadZero',
  'afterReloadPayload',
  'afterReloadLater',
  'afterReloadTail',
];

async function runVisualAcceptance({ port, controlDir }) {
  await runChartVisualAcceptance(port, controlDir);
  await runGridBeforeReload(port, controlDir);
  const reloadMarker = await waitForJson(
    path.join(controlDir, 'grid-reload-marker.json'),
    CONTROL_TIMEOUT_MS,
    'grid reload marker'
  );
  await waitForJson(
    path.join(controlDir, 'grid-after-reload-ready.json'),
    CONTROL_TIMEOUT_MS,
    'reloaded Extension Host grid readiness'
  );
  await runGridAfterReload(port, controlDir, reloadMarker);
}

async function runChartVisualAcceptance(port, controlDir) {
  const resultPath = path.join(controlDir, 'result.json');
  try {
    const session = await findChartWebview(port, TARGET_TIMEOUT_MS);
    const client = session.webview;
    try {
      const initial = await waitForChartState(
        client,
        state => state && state.rendered && state.requestId >= 1,
        TARGET_TIMEOUT_MS,
        'initial chart render'
      );
      const first = await dragAndWaitForRefinement(session, initial, 0.12, 0.42, 'first drag zoom');
      const navigatorPan = await keyChartControlAndWaitForRefinement(
        session,
        first,
        'chartNavigatorWindow',
        'ArrowRight',
        'Navigator keyboard pan refinement'
      );
      const shiftPan = await shiftPanAndWaitForRefinement(
        session,
        navigatorPan,
        0.45,
        0.55,
        'Shift drag pan refinement'
      );
      const second = await dragAndWaitForRefinement(session, shiftPan, 0.25, 0.72, 'nested drag zoom');

      assertVisualEvidence(initial, first, second);
      assertPanEvidence(first, navigatorPan, shiftPan);
      await resetChartWithNativeHome(session, second, 'nested chart reset');
      const families = [];
      let familyBefore = second;
      for (const chartType of ['line', 'scatter', 'step', 'bar', 'box', 'candlestick']) {
        const evidence = await renderChartFamily(session, chartType, familyBefore, controlDir);
        families.push(evidence);
        familyBefore = evidence;
      }
      if (new Set(families.map(family => family.screenshotSha256)).size !== families.length) {
        throw new Error(`Chart family screenshots were not visually distinct: ${JSON.stringify(families)}`);
      }
      await focusChartControl(session, 'chartType');
      await dispatchChartKey(session.webview, 'Home');
      await waitForChartState(
        session.webview,
        state => state && state.controlChartType === 'line' &&
          state.chartType === familyBefore.chartType &&
          state.requestId === familyBefore.requestId,
        REFINEMENT_TIMEOUT_MS,
        'dirty chart controls with the prior chart still rendered'
      );
      await nativeChartClick(session, 'exportChart');
      const dirtyControlExport = await waitForJson(
        path.join(controlDir, 'chart-dirty-control-export.json'),
        REFINEMENT_TIMEOUT_MS,
        'dirty-control chart export message'
      );
      if (!dirtyControlExport.png || !dirtyControlExport.productionGuardAccepted ||
        dirtyControlExport.requestId !== familyBefore.requestId ||
        dirtyControlExport.activeRequestId !== familyBefore.requestId) {
        throw new Error(`Dirty-control export lost the rendered chart identity: ${JSON.stringify({
          familyBefore: compactState(familyBefore),
          dirtyControlExport,
        })}`);
      }
      writeResult(resultPath, {
        ok: true,
        initial: compactState(initial),
        first: compactState(first),
        navigatorPan: compactState(navigatorPan),
        shiftPan: compactState(shiftPan),
        second: compactState(second),
        families: families.map(compactFamilyState),
        dirtyControlExport,
      });
    } finally {
      client.close();
      session.root.close();
    }
  } catch (error) {
    writeResult(resultPath, {
      ok: false,
      error: error && error.stack ? error.stack : String(error),
    });
    throw error;
  }
}

async function runGridBeforeReload(port, controlDir) {
  const widthsPath = path.join(controlDir, 'grid-widths.json');
  const resultPath = path.join(controlDir, 'grid-before-reload-result.json');
  let session;
  try {
    session = await findGridWebview(port, GRID_PHASE_ONE_HEADERS, GRID_TIMEOUT_MS);
    const client = session.webview;
    const initial = await waitForGridState(
      client,
      state => gridHasHeaders(state, GRID_PHASE_ONE_HEADERS) &&
        state.rowRange.max >= 0 &&
        state.rowRange.max < 239,
      GRID_TIMEOUT_MS,
      'initial virtual grid viewport'
    );
    const interactions = await exerciseGridInteractions(session, GRID_PHASE_ONE_HEADERS);
    assertUncheckedAutoFit(initial);
    const fallbackWidth = initial.cellWidth;
    const initialWidths = assertAllRenderedColumns(initial, fallbackWidth);

    const uncheckedBottom = await scrollGridTo(session, 'bottom');
    assertUncheckedAutoFit(uncheckedBottom);
    if (uncheckedBottom.rowRange.max !== 239) {
      throw new Error(`Unchecked grid did not virtual-scroll to row 239: ${JSON.stringify(uncheckedBottom.rowRange)}`);
    }
    if (!uncheckedBottom.rowParityValid) {
      throw new Error('Absolute row parity classes were incorrect at the bottom virtual window');
    }
    const uncheckedBottomWidths = assertAllRenderedColumns(uncheckedBottom, fallbackWidth);
    assertSameWidths(
      initialWidths,
      uncheckedBottomWidths,
      'unchecked auto-fit rewrote widths while virtual-scrolling'
    );
    if (longestRenderedText(uncheckedBottom, 1) < 600) {
      throw new Error('The offscreen array fixture was not rendered at the bottom viewport');
    }

    await scrollGridTo(session, 'top');
    interactions.resizeDoubleClickReset = await exerciseGridResizeDoubleClickReset(
      session,
      1,
      fallbackWidth
    );
    const firstResized = await dragGridColumn(session, 0, 73);
    const firstWidth = firstResized.headerWidths[0];
    const laterResized = await dragGridColumn(session, 2, 157);
    const laterWidth = laterResized.headerWidths[2];
    if (firstWidth === laterWidth) {
      throw new Error(`Manual grid widths must be distinct, both were ${firstWidth}px`);
    }
    assertRenderedColumnWidth(laterResized, 0, firstWidth);
    assertRenderedColumnWidth(laterResized, 2, laterWidth);

    const manualBottom = await scrollGridTo(session, 'bottom');
    assertRenderedColumnWidth(manualBottom, 0, firstWidth);
    assertRenderedColumnWidth(manualBottom, 2, laterWidth);
    const widthsByPosition = {
      0: firstWidth,
      2: laterWidth,
    };
    writeResult(widthsPath, {
      ok: true,
      query: 'select from gridAcceptancePhaseOne',
      headers: manualBottom.headers,
      autoFitChecked: manualBottom.autoFitChecked,
      autoFitMode: manualBottom.autoFitMode,
      widthsByPosition,
      allRenderedCellsMatch: true,
      initialWidthsStable: true,
      interactions,
    });

    const renamed = await waitForGridState(
      client,
      state => gridHasHeaders(state, GRID_RENAMED_HEADERS) &&
        renderedColumnHasWidth(state, 0, firstWidth) &&
        renderedColumnHasWidth(state, 2, laterWidth),
      GRID_TIMEOUT_MS,
      'renamed-schema positional widths'
    );
    assertUncheckedAutoFit(renamed);
    assertRenderedColumnWidth(renamed, 0, firstWidth);
    assertRenderedColumnWidth(renamed, 2, laterWidth);
    writeResult(resultPath, {
      ok: true,
      query: 'select from gridAcceptanceRenamed',
      headers: renamed.headers,
      autoFitChecked: renamed.autoFitChecked,
      autoFitMode: renamed.autoFitMode,
      widthsByPosition,
      allRenderedCellsMatch: true,
      positionalPersistence: true,
    });
  } catch (error) {
    const failure = {
      ok: false,
      error: error && error.stack ? error.stack : String(error),
    };
    if (!fs.existsSync(widthsPath)) {
      writeResult(widthsPath, failure);
    }
    writeResult(resultPath, failure);
    throw error;
  } finally {
    closeSession(session);
  }
}

async function runGridAfterReload(port, controlDir, reloadMarker) {
  const resultPath = path.join(controlDir, 'grid-after-reload-result.json');
  let session;
  try {
    const expectedWidths = normalizedExpectedWidths(reloadMarker);
    session = await findGridWebview(port, GRID_RELOADED_HEADERS, GRID_TIMEOUT_MS);
    const client = session.webview;
    const reloaded = await waitForGridState(
      client,
      state => gridHasHeaders(state, GRID_RELOADED_HEADERS) &&
        renderedColumnHasWidth(state, 0, expectedWidths[0]) &&
        renderedColumnHasWidth(state, 2, expectedWidths[2]),
      GRID_TIMEOUT_MS,
      'persisted widths in the reloaded webview'
    );
    assertUncheckedAutoFit(reloaded);
    assertRenderedColumnWidth(reloaded, 0, expectedWidths[0]);
    assertRenderedColumnWidth(reloaded, 2, expectedWidths[2]);
    const reloadedEvidence = {
      query: 'select from gridAcceptanceReloaded',
      headers: reloaded.headers,
      widthsByPosition: {
        0: expectedWidths[0],
        2: expectedWidths[2],
      },
      allRenderedCellsMatch: true,
    };

    await setGridSelect(client, 'autoFitMode', 'wholeResult');
    await setGridCheckbox(client, 'autoFit', true);
    const manualWholeResult = await waitForGridState(
      client,
      state => state.autoFitChecked &&
        state.autoFitMode === 'wholeResult' &&
        state.headerWidths[1] === 1200 &&
        renderedColumnHasWidth(state, 0, expectedWidths[0]) &&
        renderedColumnHasWidth(state, 2, expectedWidths[2]),
      GRID_TIMEOUT_MS,
      'whole-result auto-fit with manual precedence'
    );
    if (longestRenderedText(manualWholeResult, 1) >= 600) {
      throw new Error('Whole-result width was checked while the long array was already visible');
    }

    const resetPersistedBefore = await verifyColumnWidthCheckpoint(
      controlDir,
      'reset-before',
      expectedWidths
    );
    await clickGridControl(client, 'resetColumnWidths');
    const resetState = await waitForGridState(
      client,
      state => state.autoFitChecked &&
        state.autoFitMode === 'wholeResult' &&
        state.resetColumnWidthsDisabled &&
        state.headerWidths[1] === 1200 &&
        state.headerWidths[0] !== expectedWidths[0] &&
        state.headerWidths[2] !== expectedWidths[2],
      GRID_TIMEOUT_MS,
      'whole-result recomputation after Reset column widths'
    );
    const resetPersistedAfter = await verifyColumnWidthCheckpoint(
      controlDir,
      'reset-after',
      {},
      {
        autoFitColumns: true,
        autoFitMode: 'wholeResult',
      }
    );
    const beforeScrollWidths = assertAllRenderedColumns(resetState);
    const wholeBottom = await scrollGridTo(session, 'bottom');
    const afterScrollWidths = assertAllRenderedColumns(wholeBottom);
    if (wholeBottom.rowRange.max !== 239 || longestRenderedText(wholeBottom, 1) < 600) {
      throw new Error('Whole-result acceptance did not render the offscreen long array at row 239');
    }
    assertSameWidths(
      beforeScrollWidths,
      afterScrollWidths,
      'whole-result widths changed during vertical scrolling'
    );
    if (beforeScrollWidths[1] !== 1200) {
      throw new Error(`Offscreen whole-result array should determine a 1200px width, got ${beforeScrollWidths[1]}px`);
    }

    await setGridSelect(client, 'autoFitMode', 'visibleRows');
    const visibleBottom = await waitForGridState(
      client,
      state => state.autoFitChecked &&
        state.autoFitMode === 'visibleRows' &&
        state.rowRange.max === 239 &&
        state.headerWidths[1] === 1200,
      GRID_TIMEOUT_MS,
      'visible-rows auto-fit at the long-array viewport'
    );
    const visibleBeforeScrollWidths = assertAllRenderedColumns(visibleBottom);
    const visibleTop = await scrollGridTo(session, 'top');
    const visibleAfterScrollWidths = assertAllRenderedColumns(visibleTop);
    if (
      !visibleTop.autoFitChecked ||
      visibleTop.autoFitMode !== 'visibleRows' ||
      visibleTop.rowRange.max >= 239 ||
      visibleTop.headerWidths[1] >= visibleBottom.headerWidths[1]
    ) {
      throw new Error(`Visible-rows mode did not adapt after scrolling: ${JSON.stringify({
        bottom: compactGridState(visibleBottom),
        top: compactGridState(visibleTop),
      })}`);
    }

    await setGridCheckbox(client, 'autoFit', false);
    const fixedBeforeCellPreset = await waitForGridState(
      client,
      state => !state.autoFitChecked &&
        allRenderedColumnsHaveWidth(state, state.cellWidth),
      GRID_TIMEOUT_MS,
      'fixed widths before Cell width preset'
    );
    await dragGridColumn(session, 0, 61);
    const cellPresetManual = await dragGridColumn(session, 2, 131);
    const cellPresetPersistedBefore = await verifyColumnWidthCheckpoint(
      controlDir,
      'cell-width-before',
      {
        0: cellPresetManual.headerWidths[0],
        2: cellPresetManual.headerWidths[2],
      }
    );
    await setGridNumberInput(client, 'settingsCellWidth', 207);
    const cellWidthPreset = await waitForGridState(
      client,
      state => !state.autoFitChecked &&
        state.cellWidth === 207 &&
        state.resetColumnWidthsDisabled &&
        allRenderedColumnsHaveWidth(state, 207),
      GRID_TIMEOUT_MS,
      'Cell width preset clearing positional overrides'
    );
    assertAllRenderedColumns(cellWidthPreset, 207);
    const cellPresetPersistedAfter = await verifyColumnWidthCheckpoint(
      controlDir,
      'cell-width-after',
      {},
      {
        autoFitColumns: false,
        density: 'standard',
        'standard.cellWidth': 207,
      }
    );

    await dragGridColumn(session, 0, 53);
    const densityPresetManual = await dragGridColumn(session, 2, 119);
    const densityPresetPersistedBefore = await verifyColumnWidthCheckpoint(
      controlDir,
      'density-before',
      {
        0: densityPresetManual.headerWidths[0],
        2: densityPresetManual.headerWidths[2],
      }
    );
    await setGridSelect(client, 'settingsDensity', 'comfortable');
    const densityPreset = await waitForGridState(
      client,
      state => !state.autoFitChecked &&
        state.density === 'comfortable' &&
        state.cellWidth === 180 &&
        state.resetColumnWidthsDisabled &&
        allRenderedColumnsHaveWidth(state, 180),
      GRID_TIMEOUT_MS,
      'density preset clearing positional overrides'
    );
    assertAllRenderedColumns(densityPreset, 180);
    const densityPresetPersistedAfter = await verifyColumnWidthCheckpoint(
      controlDir,
      'density-after',
      {},
      {
        autoFitColumns: false,
        density: 'comfortable',
        'comfortable.cellWidth': 180,
      }
    );

    writeResult(resultPath, {
      ok: true,
      reloaded: reloadedEvidence,
      wholeResult: {
        autoFitChecked: resetState.autoFitChecked,
        autoFitMode: resetState.autoFitMode,
        offscreenRow: 239,
        offscreenValueDeterminedWidth: beforeScrollWidths[1] === 1200,
        offscreenWidth: beforeScrollWidths[1],
        beforeScrollWidths,
        afterScrollWidths,
        widthsStable: true,
      },
      visibleRows: {
        autoFitChecked: visibleTop.autoFitChecked,
        autoFitMode: visibleTop.autoFitMode,
        beforeScrollWidths: visibleBeforeScrollWidths,
        afterScrollWidths: visibleAfterScrollWidths,
        adaptive: visibleAfterScrollWidths[1] < visibleBeforeScrollWidths[1],
      },
      cellWidthPreset: {
        value: 207,
        columnWidthsCleared: cellWidthPreset.resetColumnWidthsDisabled,
        widths: cellWidthPreset.headerWidths,
        allColumnsAffected: true,
        priorFallbackWidth: fixedBeforeCellPreset.cellWidth,
        persistedBefore: cellPresetPersistedBefore,
        persistedAfter: cellPresetPersistedAfter,
      },
      densityPreset: {
        density: densityPreset.density,
        cellWidth: densityPreset.cellWidth,
        columnWidthsCleared: densityPreset.resetColumnWidthsDisabled,
        widths: densityPreset.headerWidths,
        allColumnsAffected: true,
        persistedBefore: densityPresetPersistedBefore,
        persistedAfter: densityPresetPersistedAfter,
      },
      reset: {
        autoFitMode: resetState.autoFitMode,
        columnWidthsCleared: resetState.resetColumnWidthsDisabled,
        recomputed: true,
        offscreenValueDeterminedWidth: resetState.headerWidths[1] === 1200,
        offscreenWidth: resetState.headerWidths[1],
        persistedBefore: resetPersistedBefore,
        persistedAfter: resetPersistedAfter,
      },
      finalColumnWidths: densityPresetPersistedAfter,
    });
  } catch (error) {
    writeResult(resultPath, {
      ok: false,
      error: error && error.stack ? error.stack : String(error),
    });
    throw error;
  } finally {
    closeSession(session);
  }
}

async function verifyColumnWidthCheckpoint(
  controlDir,
  checkpoint,
  expectedColumnWidths,
  expectedSettings = {}
) {
  const readyPath = path.join(controlDir, `grid-column-widths-${checkpoint}.json`);
  const ackPath = path.join(controlDir, `grid-column-widths-${checkpoint}-ack.json`);
  writeResult(readyPath, {
    ok: true,
    checkpoint,
    expectedColumnWidths,
    expectedSettings,
  });
  const ack = await waitForJson(
    ackPath,
    GRID_TIMEOUT_MS,
    `${checkpoint} Extension Host global column-width verification`
  );
  if (!ack || ack.ok !== true || ack.checkpoint !== checkpoint) {
    throw new Error(
      `${checkpoint} Extension Host global column-width verification failed: ${JSON.stringify(ack)}`
    );
  }
  for (const [key, expected] of Object.entries(expectedSettings)) {
    if (!ack.settings || ack.settings[key] !== expected) {
      throw new Error(
        `${checkpoint} Extension Host setting ${key} mismatch: ${JSON.stringify(ack.settings)}`
      );
    }
  }
  return ack.columnWidths;
}

async function findChartWebview(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    let targets = [];
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await response.json();
    } catch (error) {
      lastError = error.message;
      await delay(POLL_MS);
      continue;
    }

    for (const target of targets) {
      if (!target || !target.webSocketDebuggerUrl ||
        !['page', 'webview', 'iframe'].includes(target.type)) {
        continue;
      }
      let client;
      try {
        client = await CdpClient.connect(target.webSocketDebuggerUrl);
        await client.send('Runtime.enable');
        await client.send('Page.enable').catch(() => undefined);
        await delay(50);
        const ready = await webviewReady(client);
        if (ready) {
          const rootTarget = targets.find(item => item && item.type === 'page' && item.webSocketDebuggerUrl);
          if (!rootTarget) {
            throw new Error('Could not find the VS Code workbench CDP target');
          }
          const root = await CdpClient.connect(rootTarget.webSocketDebuggerUrl);
          await root.send('Runtime.enable');
          await root.send('Page.enable');
          return { webview: client, root };
        }
      } catch (error) {
        lastError = error.message;
      }
      if (client) {
        client.close();
      }
    }
    await delay(POLL_MS);
  }
  throw new Error(`Timed out finding the kdb chart webview through CDP${lastError ? `: ${lastError}` : ''}`);
}

async function findGridWebview(port, expectedHeaders, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    let targets = [];
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await response.json();
    } catch (error) {
      lastError = error.message;
      await delay(POLL_MS);
      continue;
    }

    const rootTarget = targets.find(item => item && item.type === 'page' && item.webSocketDebuggerUrl);
    for (const target of targets) {
      if (!target || !target.webSocketDebuggerUrl ||
        !['page', 'webview', 'iframe'].includes(target.type)) {
        continue;
      }
      let client;
      try {
        client = await CdpClient.connect(target.webSocketDebuggerUrl);
        await client.send('Runtime.enable');
        await client.send('Page.enable').catch(() => undefined);
        const ready = await gridWebviewReady(client, expectedHeaders);
        if (!ready) {
          client.close();
          continue;
        }
        if (!rootTarget) {
          throw new Error('Could not find the VS Code workbench CDP target');
        }
        const root = await CdpClient.connect(rootTarget.webSocketDebuggerUrl);
        await root.send('Runtime.enable');
        await root.send('Page.enable');
        return { webview: client, root };
      } catch (error) {
        lastError = error.message;
        if (client) {
          client.close();
        }
      }
    }
    await delay(POLL_MS);
  }
  throw new Error(
    `Timed out finding the ${expectedHeaders.join(',')} kdb grid webview through CDP` +
    (lastError ? `: ${lastError}` : '')
  );
}

async function webviewReady(client) {
  const contextIds = client.executionContexts
    .filter(context => !context.auxData || context.auxData.isDefault !== false)
    .map(context => context.id);
  for (const contextId of contextIds.length > 0 ? contextIds : [undefined]) {
    const response = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const button = document.getElementById('openChart');
        return !!button && !button.disabled;
      })()`,
      returnByValue: true,
      ...(contextId === undefined ? {} : { contextId }),
    }).catch(() => null);
    if (response && response.result && response.result.value === true) {
      client.chartContextId = contextId;
      return true;
    }
  }
  return false;
}

async function gridWebviewReady(client, expectedHeaders) {
  const expected = JSON.stringify(expectedHeaders);
  const expression = `(() => {
    const summary = document.getElementById('summary');
    const viewport = document.getElementById('viewport');
    const headers = Array.from(document.querySelectorAll('#header .cell[data-column]'))
      .sort((left, right) => Number(left.dataset.column) - Number(right.dataset.column))
      .map(cell => String(cell.childNodes[0] && cell.childNodes[0].textContent || '').trim());
    return !!summary &&
      !!viewport &&
      !viewport.hidden &&
      /240 rows x 4 columns/.test(String(summary.textContent || '')) &&
      JSON.stringify(headers) === JSON.stringify(${expected});
  })()`;
  const contextIds = client.executionContexts
    .filter(context => !context.auxData || context.auxData.isDefault !== false)
    .map(context => context.id);
  for (const contextId of contextIds.length > 0 ? contextIds : [undefined]) {
    const response = await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      ...(contextId === undefined ? {} : { contextId }),
    }).catch(() => null);
    if (response && response.result && response.result.value === true) {
      client.gridContextId = contextId;
      return true;
    }
  }
  return false;
}

async function dragAndWaitForRefinement(session, before, startRatio, endRatio, label) {
  const client = session.webview;
  await session.root.send('Page.bringToFront');
  const outer = await visibleWebviewRect(session.root);
  const y = outer.top + before.rect.top + Math.max(8, before.rect.height * 0.45);
  const startX = outer.left + before.rect.left + before.rect.width * startRatio;
  const endX = outer.left + before.rect.left + before.rect.width * endRatio;
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: startX,
    y,
  });
  await delay(30);
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: startX,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await delay(30);
  for (let step = 1; step <= 6; step++) {
    await session.root.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + (endX - startX) * step / 6,
      y,
      button: 'left',
      buttons: 1,
    });
    await delay(20);
  }
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: endX,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });

  return waitForChartState(
    client,
    state => state &&
      state.rendered &&
      state.requestId > before.requestId &&
      state.requestedRange &&
      state.eligibleRowCount > 0,
    REFINEMENT_TIMEOUT_MS,
    label
  );
}

async function keyChartControlAndWaitForRefinement(session, before, id, key, label) {
  await focusChartControl(session, id);
  await dispatchChartKey(session.webview, key);
  return waitForChartState(
    session.webview,
    state => state && state.rendered && state.requestId > before.requestId && state.requestedRange,
    REFINEMENT_TIMEOUT_MS,
    label
  );
}

async function shiftPanAndWaitForRefinement(session, before, startRatio, endRatio, label) {
  const client = session.webview;
  await session.root.send('Page.bringToFront');
  const outer = await visibleWebviewRect(session.root);
  const y = outer.top + before.rect.top + Math.max(8, before.rect.height * 0.45);
  const startX = outer.left + before.rect.left + before.rect.width * startRatio;
  const endX = outer.left + before.rect.left + before.rect.width * endRatio;
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: startX,
    y,
    modifiers: 8,
  });
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: startX,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    modifiers: 8,
  });
  for (let step = 1; step <= 5; step++) {
    await session.root.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + (endX - startX) * step / 5,
      y,
      button: 'left',
      buttons: 1,
      modifiers: 8,
    });
  }
  const duringMove = await chartState(client);
  if (!duringMove || duringMove.requestId !== before.requestId) {
    throw new Error(`Shift-pan mousemove must not issue a source request: ${JSON.stringify({
      before: compactState(before),
      duringMove: compactState(duringMove),
    })}`);
  }
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: endX,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    modifiers: 8,
  });
  return waitForChartState(
    client,
    state => state && state.rendered && state.requestId > before.requestId && state.requestedRange,
    REFINEMENT_TIMEOUT_MS,
    label
  );
}

async function renderChartFamily(session, chartType, before, controlDir) {
  const order = ['line', 'scatter', 'step', 'bar', 'box', 'candlestick'];
  const targetIndex = order.indexOf(chartType);
  if (targetIndex < 0) {
    throw new Error(`Unsupported chart family ${chartType}`);
  }
  await focusChartControl(session, 'chartType');
  await dispatchChartKey(session.webview, 'Home');
  for (let index = 0; index < targetIndex; index += 1) {
    await dispatchChartKey(session.webview, 'ArrowDown');
  }
  await waitForChartState(
    session.webview,
    state => state && state.controlChartType === chartType,
    REFINEMENT_TIMEOUT_MS,
    `${chartType} native chart-type selection`
  );
  await nativeChartClick(session, 'renderChart');
  const rendered = await waitForChartState(
    session.webview,
    state => state && state.rendered &&
      state.requestId > before.requestId &&
      state.chartType === chartType &&
      state.controlChartType === chartType,
    REFINEMENT_TIMEOUT_MS,
    `${chartType} native chart render`
  );
  const proof = await chartCanvasPng(session.webview);
  const bytes = proof.bytes;
  if (bytes.length < 1_000) {
    throw new Error(`${chartType} chart screenshot was unexpectedly small (${bytes.length} bytes)`);
  }
  fs.writeFileSync(path.join(controlDir, `chart-family-${chartType}.png`), bytes);
  return {
    ...rendered,
    screenshotSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    screenshotByteLength: bytes.length,
    screenshotWidth: proof.width,
    screenshotHeight: proof.height,
  };
}

async function chartCanvasPng(client) {
  const response = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const canvas = document.querySelector('#chartCanvasWrap .uplot canvas, #chartCanvasWrap canvas');
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      return {
        dataUrl: canvas.toDataURL('image/png'),
        width: canvas.width,
        height: canvas.height,
      };
    })()`,
    returnByValue: true,
    ...(client.chartContextId === undefined ? {} : { contextId: client.chartContextId }),
  });
  const value = response?.result?.value;
  const prefix = 'data:image/png;base64,';
  if (!value || typeof value.dataUrl !== 'string' || !value.dataUrl.startsWith(prefix) ||
    !(value.width > 0) || !(value.height > 0)) {
    throw new Error(`Rendered chart canvas PNG is unavailable: ${JSON.stringify(value)}`);
  }
  const bytes = Buffer.from(value.dataUrl.slice(prefix.length), 'base64');
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Rendered chart canvas proof is not a PNG');
  }
  return { bytes, width: value.width, height: value.height };
}

async function resetChartWithNativeHome(session, before, label) {
  await focusChartPlotWithNativeTab(session);
  await dispatchChartKey(session.root, 'Home');
  return waitForChartState(
    session.webview,
    state => state && state.rendered && !state.requestedRange && state.fullRange &&
      state.visibleRange && rangeKey(state.visibleRange) === rangeKey(state.fullRange) &&
      state.requestId >= before.requestId,
    REFINEMENT_TIMEOUT_MS,
    label
  );
}

async function assertChartPlotFocused(client) {
  const response = await client.send('Runtime.evaluate', {
    expression: `(() => document.activeElement && document.activeElement.id === 'chartCanvasWrap')()`,
    returnByValue: true,
    ...(client.chartContextId === undefined ? {} : { contextId: client.chartContextId }),
  });
  if (!response || !response.result || response.result.value !== true) {
    throw new Error('Native chart click did not focus the keyboard-operable chart region');
  }
}

async function focusChartPlotWithNativeTab(session) {
  for (let step = 0; step < 24; step += 1) {
    try {
      await assertChartPlotFocused(session.webview);
      return;
    } catch {
      await dispatchChartKey(session.root, 'Tab');
    }
  }
  await assertChartPlotFocused(session.webview);
}

async function focusChartControl(session, id) {
  const response = await session.webview.send('Runtime.evaluate', {
    expression: `(() => {
      const control = document.getElementById(${JSON.stringify(id)});
      if (!control || control.disabled) return false;
      control.focus({ preventScroll: true });
      return document.activeElement === control;
    })()`,
    returnByValue: true,
    ...(session.webview.chartContextId === undefined
      ? {}
      : { contextId: session.webview.chartContextId }),
  });
  if (!response || !response.result || response.result.value !== true) {
    throw new Error(`Could not focus chart control ${id}`);
  }
}

async function nativeChartClick(session, id) {
  const response = await session.webview.send('Runtime.evaluate', {
    expression: `(() => {
      const control = document.getElementById(${JSON.stringify(id)});
      if (!control || control.disabled) return null;
      control.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = control.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`,
    returnByValue: true,
    ...(session.webview.chartContextId === undefined
      ? {}
      : { contextId: session.webview.chartContextId }),
  });
  const rect = response && response.result ? response.result.value : null;
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
    throw new Error(`Could not locate native chart control ${id}`);
  }
  const outer = await visibleWebviewRect(session.root);
  const x = outer.left + rect.left + rect.width / 2;
  const y = outer.top + rect.top + rect.height / 2;
  await session.root.send('Page.bringToFront');
  await session.root.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  });
}

async function dispatchChartKey(target, key) {
  const description = cdpKeyDescription(key);
  await target.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...description });
  await target.send('Input.dispatchKeyEvent', { type: 'keyUp', ...description });
}

async function visibleWebviewRect(root) {
  const response = await root.send('Runtime.evaluate', {
    expression: `(() => {
      const frames = Array.from(document.querySelectorAll('iframe.webview.ready'));
      const visible = frames.map(frame => frame.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.height > 0);
      const rect = visible[visible.length - 1];
      return rect ? {
        left: Number(rect.left),
        top: Number(rect.top),
        width: Number(rect.width),
        height: Number(rect.height)
      } : null;
    })()`,
    returnByValue: true,
  });
  const rect = response && response.result ? response.result.value : null;
  if (!rect) {
    throw new Error('Could not locate the visible kdb results webview in the VS Code workbench');
  }
  return rect;
}

async function hitTestedWebviewRect(root, innerPoint, label) {
  const response = await root.send('Runtime.evaluate', {
    expression: `(() => {
      const inner = ${JSON.stringify(innerPoint)};
      const frames = Array.from(document.querySelectorAll('iframe.webview.ready'));
      const active = document.activeElement;
      const candidates = frames.map(frame => {
        const rect = frame.getBoundingClientRect();
        const style = getComputedStyle(frame);
        const x = rect.left + Number(inner.x);
        const y = rect.top + Number(inner.y);
        return {
          frame,
          rect,
          x,
          y,
          visible: rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' && style.visibility !== 'hidden' &&
            Number(style.opacity || 1) > 0 &&
            x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom &&
            x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight
        };
      }).filter(candidate => candidate.visible &&
        document.elementFromPoint(candidate.x, candidate.y) === candidate.frame);
      const selected = candidates.find(candidate => candidate.frame === active) ||
        (candidates.length === 1 ? candidates[0] : null);
      return selected ? {
        left: Number(selected.rect.left),
        top: Number(selected.rect.top),
        width: Number(selected.rect.width),
        height: Number(selected.rect.height),
        focused: selected.frame === active,
        candidateCount: candidates.length
      } : {
        candidateCount: candidates.length,
        activeIsWebview: active instanceof HTMLIFrameElement && active.matches('iframe.webview.ready')
      };
    })()`,
    returnByValue: true,
  });
  const value = response && response.result ? response.result.value : null;
  if (!value || !(value.width > 0) || !(value.height > 0)) {
    throw new Error(`Could not uniquely hit-test the visible webview for ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

async function waitForChartState(client, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await chartState(client);
    if (predicate(latest)) {
      return latest;
    }
    await delay(POLL_MS);
  }
  throw new Error(`Timed out waiting for ${label}; last state: ${JSON.stringify(compactState(latest))}`);
}

async function chartState(client) {
  const expression = `(() => {
      const status = document.getElementById('chartStatus');
      const overlay = document.querySelector('#chartCanvasWrap .u-over');
      if (!status || !overlay) {
        return null;
      }
      const rect = overlay.getBoundingClientRect();
      const rangeMin = Number(status.dataset.rangeMin);
      const rangeMax = Number(status.dataset.rangeMax);
      const visibleRangeMin = Number(status.dataset.visibleRangeMin);
      const visibleRangeMax = Number(status.dataset.visibleRangeMax);
      const fullRangeMin = Number(status.dataset.fullRangeMin);
      const fullRangeMax = Number(status.dataset.fullRangeMax);
      return {
        status: String(status.textContent || ''),
        rendered: rect.width > 0 && rect.height > 0 && Number(status.dataset.requestId) > 0,
        requestId: Number(status.dataset.requestId || 0),
        sourceRowCount: Number(status.dataset.sourceRowCount || 0),
        eligibleRowCount: Number(status.dataset.eligibleRowCount || 0),
        sampledPointCount: Number(status.dataset.sampledPointCount || 0),
        algorithm: String(status.dataset.algorithm || ''),
        chartType: String(status.dataset.chartType || ''),
        controlChartType: String(document.getElementById('chartType')?.value || ''),
        requestedRange: Number.isFinite(rangeMin) && Number.isFinite(rangeMax) && rangeMax > rangeMin
          ? { min: rangeMin, max: rangeMax }
          : null,
        visibleRange: Number.isFinite(visibleRangeMin) && Number.isFinite(visibleRangeMax) && visibleRangeMax > visibleRangeMin
          ? { min: visibleRangeMin, max: visibleRangeMax }
          : null,
        fullRange: Number.isFinite(fullRangeMin) && Number.isFinite(fullRangeMax) && fullRangeMax > fullRangeMin
          ? { min: fullRangeMin, max: fullRangeMax }
          : null,
        rect: {
          left: Number(rect.left),
          top: Number(rect.top),
          width: Number(rect.width),
          height: Number(rect.height)
        }
      };
    })()`;
  const contextIds = client.chartContextId ? [client.chartContextId] : [];
  for (const contextId of contextIds.length > 0 ? contextIds : [undefined]) {
    const response = await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(contextId === undefined ? {} : { contextId }),
    }).catch(() => null);
    const value = response && response.result ? response.result.value || null : null;
    if (value) {
      client.chartContextId = contextId;
      return value;
    }
  }
  return null;
}

async function waitForGridState(client, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await gridState(client);
    if (latest && predicate(latest)) {
      return latest;
    }
    await delay(POLL_MS);
  }
  throw new Error(`Timed out waiting for ${label}; last state: ${JSON.stringify(compactGridState(latest))}`);
}

async function exerciseGridInteractions(session, expectedHeaders) {
  const client = session.webview;
  const initial = await waitForGridState(
    client,
    state => gridHasHeaders(state, expectedHeaders) && state.rowParityValid,
    GRID_TIMEOUT_MS,
    'accessible striped grid'
  );
  if (initial.interactionModePresent ||
    initial.headerAriaSort.some(value => value !== 'none') ||
    initial.headerTabIndexes.some(value => value !== 0) ||
    initial.headerAriaLabels.some((value, index) =>
      !value.includes(expectedHeaders[index]) || !value.includes(`column ${index + 1} of ${expectedHeaders.length}`)
    )) {
    throw new Error(`Grid header accessibility contract is incomplete: ${JSON.stringify(initial)}`);
  }
  if (!initial.oddRowBackground || initial.oddRowBackground === initial.evenRowBackground) {
    throw new Error(`Odd-row fallback/theme shade was not visible: ${JSON.stringify({
      odd: initial.oddRowBackground,
      even: initial.evenRowBackground,
    })}`);
  }
  if (initial.gridAriaLabel !== 'KDB result table' ||
    initial.gridAriaMultiselectable !== 'true' ||
    initial.gridAriaRowCount !== 241 ||
    initial.gridAriaColCount !== expectedHeaders.length + 1 ||
    initial.headerRowIndex !== 1 ||
    JSON.stringify(initial.headerAriaColIndexes) !== JSON.stringify([2, 3, 4, 5]) ||
    initial.headerAriaSelected.some(value => value !== 'false') ||
    !initial.bodyAccessibilityValid) {
    throw new Error(`Grid DOM accessibility ownership is incomplete: ${JSON.stringify(initial)}`);
  }
  assertExactGridOrder(
    await collectGridRows(session),
    expectedGridRows('source'),
    'source'
  );

  const accessibility = await gridAccessibilityState(client);
  const namedGrid = accessibility.namedGrid;
  if (!namedGrid || namedGrid.name !== 'KDB result table' ||
    namedGrid.multiselectable !== true) {
    throw new Error(`Named KDB grid is missing from the accessibility tree: ${JSON.stringify(accessibility)}`);
  }
  for (const role of ['row', 'columnheader', 'rowheader', 'gridcell']) {
    if (!namedGrid.descendantRoles[role]) {
      throw new Error(`Named KDB grid does not own ${role}: ${JSON.stringify(accessibility)}`);
    }
  }

  await activateGridHeader(session, 0);
  const ascending = await waitForGridState(
    client,
    state => state.headerAriaSort[0] === 'ascending' && numericColumnIsOrdered(state, 0, 1),
    GRID_TIMEOUT_MS,
    'header ascending sort'
  );
  if ((ascending.bodyTexts[0] || []).some(value => value === '')) {
    throw new Error(`Ascending sort placed a q null in the top viewport: ${JSON.stringify(ascending.bodyTexts[0])}`);
  }
  assertExactGridOrder(
    await collectGridRows(session),
    expectedGridRows('ascending'),
    'ascending'
  );
  const ascendingAccessibility = await gridAccessibilityState(client);
  if (!ascendingAccessibility.namedGrid ||
    (!ascendingAccessibility.namedGrid.sortValues.includes('ascending') &&
      !ascendingAccessibility.namedGrid.columnHeaderNames.some(name =>
        name.includes('sorted ascending')
      ))) {
    throw new Error(`Ascending sort is absent from the named grid AX tree: ${JSON.stringify(ascendingAccessibility)}`);
  }

  await activateGridHeader(session, 0);
  const descending = await waitForGridState(
    client,
    state => state.headerAriaSort[0] === 'descending' && numericColumnIsOrdered(state, 0, -1),
    GRID_TIMEOUT_MS,
    'header descending sort'
  );
  if ((descending.bodyTexts[0] || []).some(value => value === '')) {
    throw new Error(`Descending sort placed a q null in the top viewport: ${JSON.stringify(descending.bodyTexts[0])}`);
  }
  assertExactGridOrder(
    await collectGridRows(session),
    expectedGridRows('descending'),
    'descending'
  );

  await activateGridHeader(session, 0);
  const sourceRestored = await waitForGridState(
    client,
    state => gridHasHeaders(state, expectedHeaders) &&
      state.headerAriaSort.every(value => value === 'none') &&
      JSON.stringify(state.bodyTexts[0] || []) === JSON.stringify(initial.bodyTexts[0] || []),
    GRID_TIMEOUT_MS,
    'header source-order restore'
  );
  if (!sourceRestored.rowParityValid) {
    throw new Error('Source-order restoration lost absolute row parity');
  }
  assertExactGridOrder(
    await collectGridRows(session),
    expectedGridRows('source'),
    'restored source'
  );

  await activateGridHeader(session, 0, { jitterPixels: 3 });
  await waitForGridState(client, state => state.headerAriaSort[0] === 'ascending', GRID_TIMEOUT_MS, 'sub-threshold jitter sort');
  await activateGridHeader(session, 0);
  await waitForGridState(client, state => state.headerAriaSort[0] === 'descending', GRID_TIMEOUT_MS, 'post-jitter descending sort');
  await activateGridHeader(session, 0);
  await waitForGridState(
    client,
    state => gridHasHeaders(state, expectedHeaders) && state.headerAriaSort.every(value => value === 'none'),
    GRID_TIMEOUT_MS,
    'post-jitter source-order restore'
  );

  await dragGridHeader(session, 0, 1);
  const reorderedHeaders = [expectedHeaders[1], expectedHeaders[0], ...expectedHeaders.slice(2)];
  await waitForGridState(
    client,
    state => gridHasHeaders(state, reorderedHeaders) && state.headerAriaSort.every(value => value === 'none'),
    GRID_TIMEOUT_MS,
    'threshold drag reorder without sort'
  );
  await dispatchGridHeaderKey(session, 1, 'ArrowLeft', { altKey: true }, {
    label: 'Alt+Left header reorder restore',
    before: state => gridHasHeaders(state, reorderedHeaders) &&
      state.headerAriaSort.every(value => value === 'none'),
    after: state => gridHasHeaders(state, expectedHeaders) &&
      state.headerAriaSort.every(value => value === 'none'),
  });
  await waitForGridState(
    client,
    state => gridHasHeaders(state, expectedHeaders) && state.headerAriaSort.every(value => value === 'none'),
    GRID_TIMEOUT_MS,
    'Alt+Left header reorder restore'
  );

  // Establish outer-frame focus with a real pointer event before routing native
  // keyboard input through the workbench target. Focusing only the child CDP
  // execution context does not reliably focus its embedding iframe.
  await activateGridHeader(session, 0);
  await waitForGridState(client, state => state.headerAriaSort[0] === 'ascending', GRID_TIMEOUT_MS, 'native focus header sort');
  await dispatchGridHeaderKey(session, 0, 'Enter', {}, {
    label: 'Enter header sort',
    before: state => JSON.stringify(state.headerAriaSort) ===
      JSON.stringify(['ascending', 'none', 'none', 'none']),
    after: state => JSON.stringify(state.headerAriaSort) ===
      JSON.stringify(['descending', 'none', 'none', 'none']),
  });
  await waitForGridState(client, state => state.headerAriaSort[0] === 'descending', GRID_TIMEOUT_MS, 'Enter header sort');
  await dispatchGridHeaderKey(session, 0, ' ', {}, {
    label: 'keyboard source-order restore',
    before: state => JSON.stringify(state.headerAriaSort) ===
      JSON.stringify(['descending', 'none', 'none', 'none']),
    after: state => gridHasHeaders(state, expectedHeaders) &&
      state.headerAriaSort.every(value => value === 'none'),
  });
  await waitForGridState(
    client,
    state => gridHasHeaders(state, expectedHeaders) && state.headerAriaSort.every(value => value === 'none'),
    GRID_TIMEOUT_MS,
    'keyboard source-order restore'
  );

  await activateGridHeader(session, 0, { ctrlKey: true });
  await waitForGridState(
    client,
    state => JSON.stringify(state.selectedHeaderColumns) === JSON.stringify([0]),
    GRID_TIMEOUT_MS,
    'Control+click full-column selection'
  );
  await dispatchGridHeaderKey(session, 1, ' ', { ctrlKey: true }, {
    label: 'Control+Space full-column selection',
    before: state => JSON.stringify(state.selectedHeaderColumns) === JSON.stringify([0]),
    after: state => JSON.stringify(state.selectedHeaderColumns) === JSON.stringify([1]) &&
      state.activeHeaderColumn === 1,
  });
  await waitForGridState(
    client,
    state => JSON.stringify(state.selectedHeaderColumns) === JSON.stringify([1]) &&
      state.activeHeaderColumn === 1,
    GRID_TIMEOUT_MS,
    'Control+Space full-column selection with retained header focus'
  );
  await dispatchGridHeaderKey(session, 3, ' ', { ctrlKey: true, shiftKey: true }, {
    label: 'Control+Shift header selection extension',
    // Focusing column 3 is safe setup and intentionally changes only the
    // active header before the native selection-extension key is dispatched.
    before: state => JSON.stringify(state.selectedHeaderColumns) === JSON.stringify([1]),
    after: state => JSON.stringify(state.selectedHeaderColumns) === JSON.stringify([1, 2, 3]) &&
      JSON.stringify(state.ariaSelectedHeaderColumns) === JSON.stringify([1, 2, 3]) &&
      JSON.stringify(state.selectedBodyColumns) === JSON.stringify([1, 2, 3]) &&
      state.activeHeaderColumn === 3,
  });
  const extended = await waitForGridState(
    client,
    state => JSON.stringify(state.selectedHeaderColumns) === JSON.stringify([1, 2, 3]) &&
      JSON.stringify(state.ariaSelectedHeaderColumns) === JSON.stringify([1, 2, 3]) &&
      JSON.stringify(state.selectedBodyColumns) === JSON.stringify([1, 2, 3]) &&
      state.activeHeaderColumn === 3,
    GRID_TIMEOUT_MS,
    'Control+Shift header selection extension with retained header focus'
  );
  const selectedAccessibility = await gridAccessibilityState(client);
  if (!selectedAccessibility.namedGrid ||
    selectedAccessibility.namedGrid.selectedColumnHeaders < 3 ||
    selectedAccessibility.namedGrid.selectedGridCells < 1) {
    throw new Error(`Grid AX selection is not owned by the named grid: ${JSON.stringify(selectedAccessibility)}`);
  }
  return {
    triState: true,
    jitterSort: true,
    dragReorderWithoutSort: true,
    keyboardSortAndReorder: true,
    pointerKeyboardAndShiftSelection: true,
    nativeInput: true,
    aria: true,
    accessibilityTree: selectedAccessibility,
    absoluteRowParity: extended.rowParityValid,
    oddRowBackground: initial.oddRowBackground,
    evenRowBackground: initial.evenRowBackground,
  };
}

async function activateGridHeader(session, column, options = {}) {
  const rect = await gridHeaderRect(session.webview, column);
  const outer = await visibleWebviewRect(session.root);
  const startX = outer.left + rect.left + Math.min(rect.width / 2, Math.max(8, rect.width - 20));
  const endX = startX + Number(options.jitterPixels || 0);
  const y = outer.top + rect.top + rect.height / 2;
  const modifiers = inputModifiers(options);
  await session.root.send('Page.bringToFront');
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: startX, y, modifiers,
  });
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: startX, y, button: 'left', buttons: 1, clickCount: 1, modifiers,
  });
  if (endX !== startX) {
    await session.root.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: endX, y, button: 'left', buttons: 1, modifiers,
    });
  }
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: endX, y, button: 'left', buttons: 0, clickCount: 1, modifiers,
  });
}

async function dragGridHeader(session, sourceColumn, targetColumn) {
  const source = await gridHeaderRect(session.webview, sourceColumn);
  const target = await gridHeaderRect(session.webview, targetColumn);
  const outer = await visibleWebviewRect(session.root);
  const startX = outer.left + source.left + source.width / 2;
  const startY = outer.top + source.top + source.height / 2;
  const endX = outer.left + target.left + target.width / 2;
  const endY = outer.top + target.top + target.height / 2;
  await session.root.send('Page.bringToFront');
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: startX, y: startY,
  });
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1,
  });
  for (let step = 1; step <= 6; step++) {
    await session.root.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + (endX - startX) * step / 6,
      y: startY + (endY - startY) * step / 6,
      button: 'left',
      buttons: 1,
    });
  }
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: endX, y: endY, button: 'left', buttons: 0, clickCount: 1,
  });
}

async function dispatchGridHeaderKey(session, column, key, options = {}, retryGuard) {
  if (!retryGuard || typeof retryGuard.before !== 'function' ||
    typeof retryGuard.after !== 'function') {
    throw new Error(`Native grid key ${key} requires exact retry state guards`);
  }
  const keyDescription = cdpKeyDescription(key);
  const modifiers = inputModifiers(options);
  let lastReceipt = null;
  let lastSetupError = null;
  for (let attempt = 1; attempt <= NATIVE_INPUT_ATTEMPTS; attempt += 1) {
    const phase = await guardedGridInputPhase(session.webview, retryGuard);
    if (phase === 'after') {
      if (attempt === 1) {
        throw new Error(`Native grid key ${key} ${retryGuard.label} was already complete before dispatch`);
      }
      return;
    }
    const token = crypto.randomBytes(12).toString('hex');
    let armed = false;
    try {
      try {
        await focusGridHeaderForNativeInput(session, column);
        await armGridNativeKeyProbe(session.webview, token, key);
        armed = true;
      } catch (error) {
        lastSetupError = error;
        const setupPhase = await guardedGridInputPhase(session.webview, retryGuard);
        if (setupPhase === 'after') {
          return;
        }
        await delay(NATIVE_INPUT_DELAY_MS);
        continue;
      }
      await delay(NATIVE_INPUT_DELAY_MS);
      await session.root.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        modifiers,
        ...keyDescription,
      });
      await delay(NATIVE_INPUT_DELAY_MS);
      await session.root.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        modifiers,
        ...keyDescription,
      });
      lastReceipt = await waitForGridNativeKeyReceipt(session.webview, token);
      if (!lastReceipt) {
        const receiptPhase = await guardedGridInputPhase(session.webview, retryGuard);
        if (receiptPhase === 'after') {
          return;
        }
        continue;
      }
      if (!lastReceipt.trusted || lastReceipt.targetColumn !== column ||
        lastReceipt.modifiers !== modifiers) {
        throw new Error(`Native grid key reached an unexpected target: ${JSON.stringify({
          column,
          key,
          modifiers,
          receipt: lastReceipt,
        })}`);
      }
      return;
    } finally {
      if (armed) {
        await clearGridNativeKeyProbe(session.webview, token);
      }
    }
  }
  throw new Error(`Native grid key ${key} was not delivered to header ${column} after ` +
    `${NATIVE_INPUT_ATTEMPTS} guarded attempts; last receipt: ${JSON.stringify(lastReceipt)}; ` +
    `last setup error: ${lastSetupError ? lastSetupError.message : 'none'}`);
}

async function guardedGridInputPhase(client, retryGuard) {
  const state = await gridState(client);
  if (state && retryGuard.after(state)) {
    return 'after';
  }
  if (state && retryGuard.before(state)) {
    return 'before';
  }
  throw new Error(`Native input ${retryGuard.label} reached an unsafe retry state: ` +
    JSON.stringify(compactGridState(state)));
}

async function focusGridFrame(session) {
  let lastError = null;
  for (let attempt = 1; attempt <= NATIVE_INPUT_ATTEMPTS; attempt += 1) {
    let point;
    let outer;
    try {
      await session.root.send('Page.bringToFront');
      point = await gridElementHitPoint(
        session.webview,
        '#outputControlsLabel',
        'inert grid-toolbar focus label'
      );
      outer = await hitTestedWebviewRect(
        session.root,
        point,
        'inert grid-toolbar focus label'
      );
    } catch (error) {
      lastError = error;
      await delay(NATIVE_INPUT_DELAY_MS);
      continue;
    }
    const x = outer.left + point.x;
    const y = outer.top + point.y;
    await session.root.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await delay(NATIVE_INPUT_DELAY_MS);
    await session.root.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    });
    await delay(NATIVE_INPUT_DELAY_MS);
    await session.root.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    });
    if (await waitForGridDocumentFocus(session.webview)) {
      return;
    }
    lastError = new Error('Native focus click did not focus the grid document');
  }
  throw new Error(`Could not focus the grid webview after ${NATIVE_INPUT_ATTEMPTS} native attempts: ` +
    (lastError ? lastError.message : 'unknown focus failure'));
}

async function focusGridHeaderForNativeInput(session, column) {
  let lastError = null;
  for (let attempt = 1; attempt <= NATIVE_INPUT_ATTEMPTS; attempt += 1) {
    try {
      await focusGridFrame(session);
      const focused = await session.webview.send('Runtime.evaluate', {
        expression: `(async () => {
          const cell = document.querySelector('#header .cell[data-column="${column}"]');
          if (!cell) return false;
          cell.focus({ preventScroll: true });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return document.hasFocus() && document.activeElement === cell && cell.isConnected;
        })()`,
        returnByValue: true,
        awaitPromise: true,
        ...(session.webview.gridContextId === undefined ? {} : { contextId: session.webview.gridContextId }),
      });
      if (focused && focused.result && focused.result.value === true) {
        return;
      }
      lastError = new Error('Grid header was not the focused connected element');
    } catch (error) {
      lastError = error;
    }
    await delay(NATIVE_INPUT_DELAY_MS);
  }
  throw new Error(`Could not establish native focus on grid header ${column}: ` +
    (lastError ? lastError.message : 'unknown header focus failure'));
}

async function gridElementHitPoint(client, selector, label) {
  const response = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || !element.isConnected) return null;
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x: Number(x),
        y: Number(y),
        width: Number(rect.width),
        height: Number(rect.height),
        hit: hit === element || element.contains(hit),
        hitTag: hit ? String(hit.tagName || '') : '',
        hitClass: hit ? String(hit.className || '') : ''
      };
    })()`,
    returnByValue: true,
    ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
  });
  const point = response && response.result ? response.result.value : null;
  if (!point || !(point.width > 0) || !(point.height > 0) || point.hit !== true) {
    throw new Error(`Could not hit-test ${label}: ${JSON.stringify(point)}`);
  }
  return point;
}

async function waitForGridDocumentFocus(client) {
  const deadline = Date.now() + NATIVE_RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await client.send('Runtime.evaluate', {
      expression: 'document.hasFocus()',
      returnByValue: true,
      ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
    });
    if (response && response.result && response.result.value === true) {
      return true;
    }
    await delay(NATIVE_INPUT_DELAY_MS);
  }
  return false;
}

async function armGridNativeKeyProbe(client, token, key) {
  const response = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const probeKey = '__kdbSqltoolsE2eNativeKeyProbe';
      const previous = globalThis[probeKey];
      if (previous && typeof previous.cleanup === 'function') previous.cleanup();
      const probe = {
        token: ${JSON.stringify(token)},
        key: ${JSON.stringify(key)},
        received: false,
        trusted: false,
        targetColumn: null,
        modifiers: null,
        cleanup: null
      };
      const listener = event => {
        if (event.key !== probe.key) return;
        const target = event.target instanceof Element
          ? event.target.closest('#header .cell[data-column]')
          : null;
        probe.received = true;
        probe.trusted = event.isTrusted === true;
        probe.targetColumn = target ? Number(target.dataset.column) : null;
        probe.modifiers = (event.altKey ? 1 : 0) |
          (event.ctrlKey ? 2 : 0) |
          (event.metaKey ? 4 : 0) |
          (event.shiftKey ? 8 : 0);
        probe.cleanup();
      };
      probe.cleanup = () => document.removeEventListener('keydown', listener, true);
      document.addEventListener('keydown', listener, true);
      globalThis[probeKey] = probe;
      return true;
    })()`,
    returnByValue: true,
    ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
  });
  if (!response || !response.result || response.result.value !== true) {
    throw new Error(`Could not arm native grid key probe ${token}`);
  }
}

async function waitForGridNativeKeyReceipt(client, token) {
  const deadline = Date.now() + NATIVE_RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const probe = globalThis.__kdbSqltoolsE2eNativeKeyProbe;
        if (!probe || probe.token !== ${JSON.stringify(token)} || !probe.received) return null;
        return {
          trusted: probe.trusted,
          targetColumn: probe.targetColumn,
          modifiers: probe.modifiers
        };
      })()`,
      returnByValue: true,
      ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
    });
    const receipt = response && response.result ? response.result.value : null;
    if (receipt) {
      return receipt;
    }
    await delay(NATIVE_INPUT_DELAY_MS);
  }
  return null;
}

async function clearGridNativeKeyProbe(client, token) {
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const probeKey = '__kdbSqltoolsE2eNativeKeyProbe';
      const probe = globalThis[probeKey];
      if (!probe || probe.token !== ${JSON.stringify(token)}) return false;
      if (typeof probe.cleanup === 'function') probe.cleanup();
      delete globalThis[probeKey];
      return true;
    })()`,
    returnByValue: true,
    ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
  }).catch(() => null);
}

async function gridHeaderRect(client, column) {
  const response = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const cell = document.querySelector('#header .cell[data-column="${column}"]');
      if (!cell) return null;
      const rect = cell.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`,
    returnByValue: true,
    ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
  });
  const rect = response && response.result ? response.result.value : null;
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
    throw new Error(`Could not locate grid header ${column}`);
  }
  return rect;
}

function inputModifiers(options = {}) {
  return (options.altKey ? 1 : 0) |
    (options.ctrlKey ? 2 : 0) |
    (options.metaKey ? 4 : 0) |
    (options.shiftKey ? 8 : 0);
}

function cdpKeyDescription(key) {
  switch (key) {
    case 'Enter': return { key, code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    case ' ': return { key, code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
    case 'ArrowLeft': return { key, code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 };
    case 'ArrowRight': return { key, code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 };
    case 'ArrowDown': return { key, code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 };
    case 'Home': return { key, code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 };
    case 'Tab': return { key, code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
    default: throw new Error(`Unsupported native grid key ${key}`);
  }
}

async function gridAccessibilityState(client) {
  await client.send('Accessibility.enable');
  const activeContext = client.executionContexts.find(
    context => context.id === client.gridContextId
  );
  const frameId = activeContext && activeContext.auxData
    ? activeContext.auxData.frameId
    : undefined;
  const response = await client.send(
    'Accessibility.getFullAXTree',
    frameId ? { frameId } : {}
  );
  const roles = {};
  const nodes = response.nodes || [];
  const byId = new Map(nodes.map(node => [String(node.nodeId), node]));
  for (const node of nodes) {
    const role = String(node.role && node.role.value || '').toLowerCase();
    if (role) roles[role] = (roles[role] || 0) + 1;
  }
  const property = (node, name) => {
    const candidate = (node.properties || []).find(value => value.name === name);
    return candidate && candidate.value ? candidate.value.value : undefined;
  };
  const ownedNodes = root => {
    const owned = [];
    const pending = [...(root.childIds || [])];
    const seen = new Set();
    while (pending.length > 0) {
      const id = String(pending.shift());
      if (seen.has(id)) continue;
      seen.add(id);
      const node = byId.get(id);
      if (!node) continue;
      owned.push(node);
      pending.push(...(node.childIds || []));
    }
    return owned;
  };
  const grids = nodes
    .filter(node => String(node.role && node.role.value || '').toLowerCase() === 'grid')
    .map(node => {
      const descendants = ownedNodes(node);
      const descendantRoles = {};
      descendants.forEach(descendant => {
        const role = String(descendant.role && descendant.role.value || '').toLowerCase();
        if (role) descendantRoles[role] = (descendantRoles[role] || 0) + 1;
      });
      return {
        name: String(node.name && node.name.value || ''),
        multiselectable: property(node, 'multiselectable') === true,
        descendantRoles,
        selectedColumnHeaders: descendants.filter(descendant =>
          String(descendant.role && descendant.role.value || '').toLowerCase() === 'columnheader' &&
          property(descendant, 'selected') === true
        ).length,
        selectedGridCells: descendants.filter(descendant =>
          String(descendant.role && descendant.role.value || '').toLowerCase() === 'gridcell' &&
          property(descendant, 'selected') === true
        ).length,
        columnHeaderNames: descendants
          .filter(descendant =>
            String(descendant.role && descendant.role.value || '').toLowerCase() === 'columnheader'
          )
          .map(descendant => String(descendant.name && descendant.name.value || '')),
        sortValues: descendants
          .filter(descendant => String(descendant.role && descendant.role.value || '').toLowerCase() === 'columnheader')
          .map(descendant => String(property(descendant, 'sort') || '').toLowerCase())
          .filter(Boolean),
      };
    });
  return {
    frameId: String(frameId || ''),
    roles,
    grids,
    namedGrid: grids.find(grid => grid.name === 'KDB result table') || null,
  };
}

function expectedGridRows(direction) {
  const firstValues = Array.from({ length: 240 }, (_, index) => 1000 + index);
  firstValues.splice(0, 7, 1003, null, 999, 1005, 1002, 1000, 1004);
  const rows = firstValues.map((first, sourceRow) => ({
    first,
    later: 1000 + sourceRow / 10,
  }));
  if (direction === 'source') return rows;
  return rows.slice().sort((left, right) => {
    if (left.first === null) return right.first === null ? 0 : 1;
    if (right.first === null) return -1;
    return direction === 'ascending'
      ? left.first - right.first
      : right.first - left.first;
  });
}

function assertExactGridOrder(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} grid body order differs from the exact fixture: ${JSON.stringify({ actual, expected })}`);
  }
}

async function collectGridRows(session) {
  const client = session.webview;
  await scrollGridTo(session, 'top');
  const rows = new Map();
  let targetRow = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = await waitForGridState(
      client,
      candidate => candidate.loadingCellCount === 0 &&
        candidate.rowRange.min <= targetRow && candidate.rowRange.max >= targetRow,
      GRID_TIMEOUT_MS,
      `loaded grid rows around ${targetRow}`
    );
    state.bodyRows.forEach(row => {
      if (Number.isSafeInteger(row.displayRow) && row.cells.length >= 3) {
        rows.set(row.displayRow, {
          first: row.cells[0] === '' ? null : Number(row.cells[0]),
          later: Number(row.cells[2]),
        });
      }
    });
    if (state.rowRange.max >= 239) break;
    targetRow = state.rowRange.max + 1;
    const response = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const viewport = document.getElementById('viewport');
        if (!viewport) return false;
        viewport.scrollTop = Math.min(viewport.scrollHeight, ${targetRow} * 28);
        viewport.dispatchEvent(new Event('scroll'));
        return true;
      })()`,
      returnByValue: true,
      ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
    });
    if (!response || !response.result || response.result.value !== true) {
      throw new Error(`Could not advance grid collection to display row ${targetRow}`);
    }
  }
  await scrollGridTo(session, 'top');
  if (rows.size !== 240) {
    throw new Error(`Exact grid-order collection saw ${rows.size} of 240 rows`);
  }
  return Array.from({ length: 240 }, (_, displayRow) => rows.get(displayRow));
}

function numericColumnIsOrdered(state, column, direction) {
  const values = (state.bodyTexts[column] || [])
    .filter(value => value !== '')
    .map(Number);
  return values.length > 1 && values.every((value, index) =>
    Number.isFinite(value) && (index === 0 || direction * value >= direction * values[index - 1])
  );
}

function assertNullLast(state, direction) {
  const values = state.bodyTexts[0] || [];
  if (values.length === 0 || values[values.length - 1] !== '') {
    throw new Error(`${direction} sort did not keep the q null last: ${JSON.stringify(values)}`);
  }
}

async function gridState(client) {
  const expression = `(() => {
    const viewport = document.getElementById('viewport');
    const summary = document.getElementById('summary');
    const autoFit = document.getElementById('autoFit');
    const autoFitMode = document.getElementById('autoFitMode');
    const cellWidth = document.getElementById('settingsCellWidth');
    const density = document.getElementById('settingsDensity');
    const resetColumnWidths = document.getElementById('resetColumnWidths');
    if (!viewport || !summary || !autoFit || !autoFitMode || !cellWidth || !density || !resetColumnWidths) {
      return null;
    }
    const width = element => {
      const inline = Number.parseFloat(String(element.style.width || ''));
      return Number.isFinite(inline) ? inline : Number(element.getBoundingClientRect().width);
    };
    const headerCells = Array.from(document.querySelectorAll('#header .cell[data-column]'))
      .sort((left, right) => Number(left.dataset.column) - Number(right.dataset.column));
    const bodyCells = Array.from(document.querySelectorAll('#rows .cell[data-row][data-column]'));
    const headers = [];
    const headerWidths = [];
    const headerAriaSort = [];
    const headerAriaLabels = [];
    const headerTabIndexes = [];
    const headerAriaColIndexes = [];
    const headerAriaSelected = [];
    const selectedHeaderColumns = [];
    headerCells.forEach(cell => {
      const column = Number(cell.dataset.column);
      headers[column] = String(cell.childNodes[0] && cell.childNodes[0].textContent || '').trim();
      headerWidths[column] = width(cell);
      headerAriaSort[column] = String(cell.getAttribute('aria-sort') || '');
      headerAriaLabels[column] = String(cell.getAttribute('aria-label') || '');
      headerTabIndexes[column] = Number(cell.tabIndex);
      headerAriaColIndexes[column] = Number(cell.getAttribute('aria-colindex'));
      headerAriaSelected[column] = String(cell.getAttribute('aria-selected') || '');
      if (cell.classList.contains('selected')) {
        selectedHeaderColumns.push(column);
      }
    });
    const bodyWidths = {};
    const bodyTexts = {};
    const rows = [];
    bodyCells.forEach(cell => {
      const column = Number(cell.dataset.column);
      const row = Number(cell.dataset.row);
      if (!bodyWidths[column]) {
        bodyWidths[column] = [];
        bodyTexts[column] = [];
      }
      bodyWidths[column].push(width(cell));
      bodyTexts[column].push(String(cell.textContent || ''));
      rows.push(row);
    });
    const renderedRows = Array.from(document.querySelectorAll('#rows .row'));
    const bodyRows = renderedRows.map(row => ({
      displayRow: Number(row.getAttribute('aria-rowindex')) - 2,
      cells: Array.from(row.querySelectorAll('.cell[data-column]:not([data-column="-1"])'))
        .sort((left, right) => Number(left.dataset.column) - Number(right.dataset.column))
        .map(cell => String(cell.textContent || '')),
    }));
    const loadingCellCount = bodyCells.filter(cell => cell.classList.contains('loading')).length;
    const dataColumns = headerCells.map(cell => Number(cell.dataset.column));
    const selectedBodyColumns = dataColumns.filter(column => {
      const cells = bodyCells.filter(cell => Number(cell.dataset.column) === column);
      return cells.length > 0 && cells.every(cell => cell.getAttribute('aria-selected') === 'true');
    });
    const bodyAccessibilityValid = renderedRows.every(row => {
      const displayRow = Number(row.getAttribute('aria-rowindex')) - 2;
      const rowHeader = row.querySelector('.cell[data-column="-1"]');
      const cells = Array.from(row.querySelectorAll('.cell[data-column]:not([data-column="-1"])'));
      return row.getAttribute('role') === 'row' && Number.isSafeInteger(displayRow) &&
        (!rowHeader || (rowHeader.getAttribute('role') === 'rowheader' &&
          Number(rowHeader.getAttribute('aria-colindex')) === 1)) &&
        cells.every(cell => cell.getAttribute('role') === 'gridcell' &&
          Number(cell.getAttribute('aria-colindex')) === Number(cell.dataset.column) + 2 &&
          (cell.getAttribute('aria-selected') === 'true' || cell.getAttribute('aria-selected') === 'false'));
    });
    const rowParityValid = renderedRows.every(row => {
      const rowCell = row.querySelector('.cell[data-row]');
      const rowIndex = Number(rowCell && rowCell.dataset.row);
      return Number.isSafeInteger(rowIndex) &&
        row.classList.contains(rowIndex % 2 === 0 ? 'row-even' : 'row-odd');
    });
    const oddRow = renderedRows.find(row => row.classList.contains('row-odd'));
    const evenRow = renderedRows.find(row => row.classList.contains('row-even'));
    const rowBackground = row => {
      const cell = row && row.querySelector('.cell:not(.selected):not(.search-match):not(.loading)');
      return cell ? getComputedStyle(cell).backgroundColor : '';
    };
    return {
      summary: String(summary.textContent || ''),
      headers,
      headerWidths,
      headerAriaSort,
      headerAriaLabels,
      headerTabIndexes,
      headerAriaColIndexes,
      headerAriaSelected,
      selectedHeaderColumns,
      ariaSelectedHeaderColumns: headerAriaSelected
        .map((value, column) => value === 'true' ? column : -1)
        .filter(column => column >= 0),
      selectedBodyColumns,
      activeHeaderColumn: document.activeElement && document.activeElement.matches('#header .cell[data-column]')
        ? Number(document.activeElement.dataset.column)
        : -1,
      interactionModePresent: !!document.getElementById('interactionMode'),
      rowParityValid,
      bodyAccessibilityValid,
      bodyRows,
      loadingCellCount,
      gridAriaLabel: String(viewport.getAttribute('aria-label') || ''),
      gridAriaMultiselectable: String(viewport.getAttribute('aria-multiselectable') || ''),
      gridAriaRowCount: Number(viewport.getAttribute('aria-rowcount')),
      gridAriaColCount: Number(viewport.getAttribute('aria-colcount')),
      headerRowIndex: Number(document.getElementById('header')?.getAttribute('aria-rowindex')),
      oddRowBackground: rowBackground(oddRow),
      evenRowBackground: rowBackground(evenRow),
      bodyWidths,
      bodyTexts,
      rowRange: {
        min: rows.length > 0 ? Math.min(...rows) : -1,
        max: rows.length > 0 ? Math.max(...rows) : -1
      },
      autoFitChecked: !!autoFit.checked,
      autoFitDisabled: !!autoFit.disabled,
      autoFitMode: String(autoFitMode.value || ''),
      autoFitModeDisabled: !!autoFitMode.disabled,
      cellWidth: Number(cellWidth.value),
      density: String(density.value || ''),
      resetColumnWidthsDisabled: !!resetColumnWidths.disabled,
      scrollTop: Number(viewport.scrollTop),
      scrollHeight: Number(viewport.scrollHeight),
      clientHeight: Number(viewport.clientHeight)
    };
  })()`;
  const contextIds = client.gridContextId === undefined ? [] : [client.gridContextId];
  for (const contextId of contextIds.length > 0 ? contextIds : [undefined]) {
    const response = await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(contextId === undefined ? {} : { contextId }),
    }).catch(() => null);
    const value = response && response.result ? response.result.value || null : null;
    if (value) {
      client.gridContextId = contextId;
      return value;
    }
  }
  return null;
}

async function scrollGridTo(session, edge) {
  const client = session.webview;
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const viewport = document.getElementById('viewport');
      if (!viewport) {
        return false;
      }
      viewport.scrollTop = ${edge === 'bottom' ? 'viewport.scrollHeight' : '0'};
      viewport.dispatchEvent(new Event('scroll'));
      return true;
    })()`,
    returnByValue: true,
    ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
  });
  return waitForGridState(
    client,
    state => edge === 'bottom'
      ? state.rowRange.max === 239 && longestRenderedText(state, 1) >= 600
      : state.rowRange.min === 0 &&
        state.rowRange.max >= 0 &&
        state.rowRange.max < 239 &&
        longestRenderedText(state, 1) > 0,
    GRID_TIMEOUT_MS,
    `${edge} grid viewport`
  );
}

async function dragGridColumn(session, column, delta) {
  const client = session.webview;
  const before = await waitForGridState(
    client,
    state => Number.isFinite(state.headerWidths[column]) &&
      Array.isArray(state.bodyWidths[column]) &&
      state.bodyWidths[column].length > 0,
    GRID_TIMEOUT_MS,
    `column ${column} resize handle`
  );
  const expectedWidth = before.headerWidths[column] + delta;
  await ensureGridResizeHandleVisible(client, column, delta);
  const rectResponse = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const handle = document.querySelector('#header .resize-handle[data-column="${column}"]');
      if (!handle) {
        return null;
      }
      const rect = handle.getBoundingClientRect();
      return {
        left: Number(rect.left),
        top: Number(rect.top),
        width: Number(rect.width),
        height: Number(rect.height)
      };
    })()`,
    returnByValue: true,
    ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
  });
  const rect = rectResponse && rectResponse.result ? rectResponse.result.value : null;
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`Could not locate resize handle for grid column ${column}`);
  }

  await session.root.send('Page.bringToFront');
  const outer = await visibleWebviewRect(session.root);
  const startX = outer.left + rect.left + rect.width / 2;
  const startY = outer.top + rect.top + rect.height / 2;
  const endX = startX + delta;
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: startX,
    y: startY,
  });
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: startX,
    y: startY,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= 4; step++) {
    await session.root.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + delta * step / 4,
      y: startY,
      button: 'left',
      buttons: 1,
    });
  }
  await session.root.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: endX,
    y: startY,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });

  return waitForGridState(
    client,
    state => renderedColumnHasWidth(state, column, expectedWidth),
    GRID_TIMEOUT_MS,
    `column ${column} width ${expectedWidth}px`
  );
}

async function exerciseGridResizeDoubleClickReset(session, column, fallbackWidth) {
  const resized = await dragGridColumn(session, column, 47);
  if (resized.headerWidths[column] === fallbackWidth) {
    throw new Error(`Column ${column} did not resize before double-click reset`);
  }
  const client = session.webview;
  await dispatchGridResizeDoubleClick(
    session,
    column,
    resized.headerWidths[column],
    fallbackWidth
  );
  const reset = await waitForGridState(
    client,
    state => renderedColumnHasWidth(state, column, fallbackWidth),
    GRID_TIMEOUT_MS,
    `column ${column} resize double-click reset`
  );
  return {
    column,
    resizedWidth: resized.headerWidths[column],
    resetWidth: reset.headerWidths[column],
    fallbackWidth,
  };
}

async function dispatchGridResizeDoubleClick(session, column, resizedWidth, fallbackWidth) {
  const client = session.webview;
  let lastReceipt = null;
  let lastSetupError = null;
  for (let attempt = 1; attempt <= NATIVE_INPUT_ATTEMPTS; attempt += 1) {
    const phase = await guardedGridResizePhase(client, column, resizedWidth, fallbackWidth);
    if (phase === 'after') {
      if (attempt === 1) {
        throw new Error(`Column ${column} was reset before native double-click dispatch`);
      }
      return;
    }
    const token = crypto.randomBytes(12).toString('hex');
    let armed = false;
    let point;
    let outer;
    try {
      try {
        await focusGridFrame(session);
        await ensureGridResizeHandleVisible(client, column, 0);
        point = await gridElementHitPoint(
          client,
          `#header .resize-handle[data-column="${column}"]`,
          `grid column ${column} resize handle`
        );
        await session.root.send('Page.bringToFront');
        outer = await hitTestedWebviewRect(
          session.root,
          point,
          `grid column ${column} resize handle`
        );
        await armGridNativeDoubleClickProbe(client, token);
        armed = true;
      } catch (error) {
        lastSetupError = error;
        const setupPhase = await guardedGridResizePhase(client, column, resizedWidth, fallbackWidth);
        if (setupPhase === 'after') {
          return;
        }
        await delay(NATIVE_INPUT_DELAY_MS);
        continue;
      }
      const x = outer.left + point.x;
      const y = outer.top + point.y;
      await session.root.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await delay(NATIVE_INPUT_DELAY_MS);
      // One clickCount=2 press/release makes Chromium emit dblclick before the
      // resize mouseup's queued render can replace the handle EventTarget.
      await session.root.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2,
      });
      await delay(NATIVE_INPUT_DELAY_MS);
      await session.root.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2,
      });
      lastReceipt = await waitForGridNativeDoubleClickReceipt(client, token);
      if (!lastReceipt) {
        const receiptPhase = await guardedGridResizePhase(client, column, resizedWidth, fallbackWidth);
        if (receiptPhase === 'after') {
          return;
        }
        continue;
      }
      if (!lastReceipt.trusted || lastReceipt.targetColumn !== column) {
        throw new Error(`Native resize double-click reached an unexpected target: ${JSON.stringify({
          column,
          receipt: lastReceipt,
        })}`);
      }
      return;
    } finally {
      if (armed) {
        await clearGridNativeDoubleClickProbe(client, token);
      }
    }
  }
  throw new Error(`Native resize double-click was not delivered to column ${column} after ` +
    `${NATIVE_INPUT_ATTEMPTS} guarded attempts; last receipt: ${JSON.stringify(lastReceipt)}; ` +
    `last setup error: ${lastSetupError ? lastSetupError.message : 'none'}`);
}

async function guardedGridResizePhase(client, column, resizedWidth, fallbackWidth) {
  const state = await gridState(client);
  if (renderedColumnHasWidth(state, column, fallbackWidth)) {
    return 'after';
  }
  if (renderedColumnHasWidth(state, column, resizedWidth)) {
    return 'before';
  }
  throw new Error(`Column ${column} reached an unsafe resize-reset retry state: ` +
    JSON.stringify(compactGridState(state)));
}

async function armGridNativeDoubleClickProbe(client, token) {
  const response = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const probeKey = '__kdbSqltoolsE2eNativeDoubleClickProbe';
      const previous = globalThis[probeKey];
      if (previous && typeof previous.cleanup === 'function') previous.cleanup();
      const probe = {
        token: ${JSON.stringify(token)},
        received: false,
        trusted: false,
        targetColumn: null,
        cleanup: null
      };
      const listener = event => {
        const target = event.target instanceof Element
          ? event.target.closest('#header .resize-handle[data-column]')
          : null;
        probe.received = true;
        probe.trusted = event.isTrusted === true;
        probe.targetColumn = target ? Number(target.dataset.column) : null;
        probe.cleanup();
      };
      probe.cleanup = () => document.removeEventListener('dblclick', listener, true);
      document.addEventListener('dblclick', listener, true);
      globalThis[probeKey] = probe;
      return true;
    })()`,
    returnByValue: true,
    ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
  });
  if (!response || !response.result || response.result.value !== true) {
    throw new Error(`Could not arm native grid double-click probe ${token}`);
  }
}

async function waitForGridNativeDoubleClickReceipt(client, token) {
  const deadline = Date.now() + NATIVE_RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const probe = globalThis.__kdbSqltoolsE2eNativeDoubleClickProbe;
        if (!probe || probe.token !== ${JSON.stringify(token)} || !probe.received) return null;
        return { trusted: probe.trusted, targetColumn: probe.targetColumn };
      })()`,
      returnByValue: true,
      ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
    });
    const receipt = response && response.result ? response.result.value : null;
    if (receipt) {
      return receipt;
    }
    await delay(NATIVE_INPUT_DELAY_MS);
  }
  return null;
}

async function clearGridNativeDoubleClickProbe(client, token) {
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const probeKey = '__kdbSqltoolsE2eNativeDoubleClickProbe';
      const probe = globalThis[probeKey];
      if (!probe || probe.token !== ${JSON.stringify(token)}) return false;
      if (typeof probe.cleanup === 'function') probe.cleanup();
      delete globalThis[probeKey];
      return true;
    })()`,
    returnByValue: true,
    ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
  }).catch(() => null);
}

async function ensureGridResizeHandleVisible(client, column, delta) {
  const response = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const viewport = document.getElementById('viewport');
      let handle = document.querySelector('#header .resize-handle[data-column="${column}"]');
      if (!viewport || !handle) {
        return false;
      }
      const viewportRect = viewport.getBoundingClientRect();
      const contentRight = viewportRect.left + viewport.clientWidth;
      const handleRect = handle.getBoundingClientRect();
      const rightwardRoom = Math.max(24, Number(${delta}) + 12);
      if (handleRect.right > contentRight - rightwardRoom) {
        viewport.scrollLeft += handleRect.right - (contentRight - rightwardRoom);
      } else if (handleRect.left < viewportRect.left + 4) {
        viewport.scrollLeft = Math.max(0, viewport.scrollLeft - (viewportRect.left - handleRect.left + 20));
      }
      viewport.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      handle = document.querySelector('#header .resize-handle[data-column="${column}"]');
      if (!handle) {
        return false;
      }
      const next = handle.getBoundingClientRect();
      const visible = viewport.getBoundingClientRect();
      return next.left >= visible.left + 4 &&
        next.right + Math.max(0, Number(${delta})) <= visible.left + viewport.clientWidth - 4;
    })()`,
    returnByValue: true,
    awaitPromise: true,
    ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
  });
  if (!response || !response.result || response.result.value !== true) {
    throw new Error(`Could not scroll grid resize handle ${column} into view`);
  }
}

async function setGridCheckbox(client, id, checked) {
  await evaluateGridControl(client, id, `element.checked = ${checked ? 'true' : 'false'};`);
  return waitForGridState(
    client,
    state => id !== 'autoFit' || state.autoFitChecked === checked,
    GRID_TIMEOUT_MS,
    `${id}=${checked}`
  );
}

async function setGridSelect(client, id, value) {
  await evaluateGridControl(client, id, `element.value = ${JSON.stringify(value)};`);
  return waitForGridState(
    client,
    state => id === 'autoFitMode'
      ? state.autoFitMode === value
      : id === 'settingsDensity'
        ? state.density === value
        : true,
    GRID_TIMEOUT_MS,
    `${id}=${value}`
  );
}

async function setGridNumberInput(client, id, value) {
  await evaluateGridControl(client, id, `element.value = ${JSON.stringify(String(value))};`);
  return waitForGridState(
    client,
    state => id !== 'settingsCellWidth' || state.cellWidth === value,
    GRID_TIMEOUT_MS,
    `${id}=${value}`
  );
}

async function evaluateGridControl(client, id, assignment) {
  const response = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const element = document.getElementById(${JSON.stringify(id)});
      if (!element) {
        return false;
      }
      ${assignment}
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    returnByValue: true,
    ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
  });
  if (!response || !response.result || response.result.value !== true) {
    throw new Error(`Could not update grid control ${id}`);
  }
}

async function clickGridControl(client, id) {
  const response = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const element = document.getElementById(${JSON.stringify(id)});
      if (!element || element.disabled) {
        return false;
      }
      element.click();
      return true;
    })()`,
    returnByValue: true,
    ...(client.gridContextId === undefined ? {} : { contextId: client.gridContextId }),
  });
  if (!response || !response.result || response.result.value !== true) {
    throw new Error(`Could not click grid control ${id}`);
  }
}

function assertUncheckedAutoFit(state) {
  if (state.autoFitChecked || state.autoFitMode !== 'wholeResult') {
    throw new Error(`Expected unchecked whole-result auto-fit controls: ${JSON.stringify(compactGridState(state))}`);
  }
}

function gridHasHeaders(state, expectedHeaders) {
  return !!state &&
    Array.isArray(state.headers) &&
    JSON.stringify(state.headers) === JSON.stringify(expectedHeaders);
}

function renderedColumnHasWidth(state, column, expectedWidth) {
  if (!state || !Number.isFinite(expectedWidth) ||
    !Number.isFinite(state.headerWidths && state.headerWidths[column]) ||
    Math.abs(state.headerWidths[column] - expectedWidth) > 0.01) {
    return false;
  }
  const bodyWidths = state.bodyWidths && state.bodyWidths[column];
  return Array.isArray(bodyWidths) &&
    bodyWidths.length > 0 &&
    bodyWidths.every(width => Number.isFinite(width) && Math.abs(width - expectedWidth) <= 0.01);
}

function assertRenderedColumnWidth(state, column, expectedWidth) {
  if (!renderedColumnHasWidth(state, column, expectedWidth)) {
    throw new Error(`Rendered column ${column} cells do not all share ${expectedWidth}px: ${JSON.stringify({
      header: state && state.headerWidths ? state.headerWidths[column] : null,
      body: state && state.bodyWidths ? state.bodyWidths[column] : null,
    })}`);
  }
}

function allRenderedColumnsHaveWidth(state, expectedWidth) {
  return !!state &&
    state.headers.length === 4 &&
    state.headers.every((_header, column) => renderedColumnHasWidth(state, column, expectedWidth));
}

function assertAllRenderedColumns(state, expectedWidth) {
  if (!state || state.headers.length !== 4) {
    throw new Error(`Expected four rendered data columns: ${JSON.stringify(compactGridState(state))}`);
  }
  const widths = state.headerWidths.slice();
  state.headers.forEach((_header, column) => {
    const width = expectedWidth === undefined ? widths[column] : expectedWidth;
    assertRenderedColumnWidth(state, column, width);
  });
  return widths;
}

function assertSameWidths(before, after, message) {
  if (
    !Array.isArray(before) ||
    !Array.isArray(after) ||
    before.length !== after.length ||
    before.some((width, index) => Math.abs(width - after[index]) > 0.01)
  ) {
    throw new Error(`${message}: ${JSON.stringify({ before, after })}`);
  }
}

function longestRenderedText(state, column) {
  const texts = state && state.bodyTexts ? state.bodyTexts[column] : null;
  return Array.isArray(texts)
    ? texts.reduce((longest, text) => Math.max(longest, String(text || '').length), 0)
    : 0;
}

function compactGridState(state) {
  if (!state) {
    return null;
  }
  return {
    summary: state.summary,
    headers: state.headers,
    headerAriaSort: state.headerAriaSort,
    headerWidths: state.headerWidths,
    selectedHeaderColumns: state.selectedHeaderColumns,
    ariaSelectedHeaderColumns: state.ariaSelectedHeaderColumns,
    selectedBodyColumns: state.selectedBodyColumns,
    activeHeaderColumn: state.activeHeaderColumn,
    rowRange: state.rowRange,
    autoFitChecked: state.autoFitChecked,
    autoFitMode: state.autoFitMode,
    cellWidth: state.cellWidth,
    density: state.density,
    resetColumnWidthsDisabled: state.resetColumnWidthsDisabled,
  };
}

function normalizedExpectedWidths(marker) {
  const source = marker && (
    marker.widthsByPosition ||
    marker.expectedWidths ||
    marker.widths
  );
  const widths = {
    0: Number(source && (source[0] === undefined ? source.firstWidth : source[0])),
    2: Number(source && (source[2] === undefined ? source.laterWidth : source[2])),
  };
  if (!Number.isFinite(widths[0]) || !Number.isFinite(widths[2]) || widths[0] === widths[2]) {
    throw new Error(`Reload marker lacks distinct positional widths: ${JSON.stringify(marker)}`);
  }
  return widths;
}

function closeSession(session) {
  if (!session) {
    return;
  }
  if (session.webview) {
    session.webview.close();
  }
  if (session.root) {
    session.root.close();
  }
}

function assertVisualEvidence(initial, first, second) {
  if (initial.sourceRowCount !== 12000 ||
    first.sourceRowCount !== 12000 ||
    second.sourceRowCount !== 12000) {
    throw new Error(`Nested zoom did not retain the 12,000-row full source: ${JSON.stringify({
      initial: initial.sourceRowCount,
      first: first.sourceRowCount,
      second: second.sourceRowCount,
    })}`);
  }
  if (!first.requestedRange || !second.requestedRange ||
    second.requestedRange.min < first.requestedRange.min ||
    second.requestedRange.max > first.requestedRange.max ||
    rangeKey(second.requestedRange) === rangeKey(first.requestedRange)) {
    throw new Error(`Second zoom is not a distinct nested absolute range: ${JSON.stringify({
      first: first.requestedRange,
      second: second.requestedRange,
    })}`);
  }
  if (!initial.fullRange ||
    rangeKey(first.fullRange || {}) !== rangeKey(initial.fullRange) ||
    rangeKey(second.fullRange || {}) !== rangeKey(initial.fullRange)) {
    throw new Error(`Immutable full range changed during nested refinement: ${JSON.stringify({
      initial: initial.fullRange,
      first: first.fullRange,
      second: second.fullRange,
    })}`);
  }
  if (rangeKey(first.visibleRange || {}) !== rangeKey(first.requestedRange) ||
    rangeKey(second.visibleRange || {}) !== rangeKey(second.requestedRange)) {
    throw new Error(`Rendered range does not match the requested nested range: ${JSON.stringify({
      first: { visible: first.visibleRange, requested: first.requestedRange },
      second: { visible: second.visibleRange, requested: second.requestedRange },
    })}`);
  }
  if (!(first.eligibleRowCount < initial.eligibleRowCount &&
    second.eligibleRowCount < first.eligibleRowCount &&
    second.eligibleRowCount > 0)) {
    throw new Error(`Nested refinements lack eligible-row evidence: ${JSON.stringify({
      initial: initial.eligibleRowCount,
      first: first.eligibleRowCount,
      second: second.eligibleRowCount,
    })}`);
  }
  for (const state of [first, second]) {
    const expected = Math.min(state.eligibleRowCount, 7000);
    if (state.sampledPointCount !== expected) {
      throw new Error(`Refined density mismatch: expected ${expected}, got ${state.sampledPointCount}`);
    }
    if (!/eligible rows/.test(state.status)) {
      throw new Error(`Chart status lacks eligible-row evidence: ${state.status}`);
    }
  }
}

function assertPanEvidence(first, navigatorPan, shiftPan) {
  const span = range => range.max - range.min;
  const close = (left, right) => Math.abs(left - right) <= Math.max(1e-7, Math.abs(right) * 1e-9);
  if (!first.requestedRange || !navigatorPan.requestedRange || !shiftPan.requestedRange) {
    throw new Error('Pan acceptance requires absolute requested ranges');
  }
  if (navigatorPan.requestId !== first.requestId + 1 || shiftPan.requestId !== navigatorPan.requestId + 1) {
    throw new Error(`Each completed pan must issue exactly one settled request: ${JSON.stringify({
      first: first.requestId,
      navigatorPan: navigatorPan.requestId,
      shiftPan: shiftPan.requestId,
    })}`);
  }
  if (!close(span(navigatorPan.requestedRange), span(first.requestedRange)) ||
    navigatorPan.requestedRange.min <= first.requestedRange.min) {
    throw new Error(`Navigator pan must preserve span and move the viewport right: ${JSON.stringify({ first, navigatorPan })}`);
  }
  if (!close(span(shiftPan.requestedRange), span(navigatorPan.requestedRange)) ||
    shiftPan.requestedRange.min >= navigatorPan.requestedRange.min) {
    throw new Error(`Shift drag must use grab-content direction and preserve span: ${JSON.stringify({ navigatorPan, shiftPan })}`);
  }
  if (navigatorPan.sourceRowCount !== first.sourceRowCount ||
    shiftPan.sourceRowCount !== first.sourceRowCount) {
    throw new Error('Completed pans must resample from the retained full chart source');
  }
  for (const state of [navigatorPan, shiftPan]) {
    if (rangeKey(state.fullRange || {}) !== rangeKey(first.fullRange || {}) ||
      rangeKey(state.visibleRange || {}) !== rangeKey(state.requestedRange || {})) {
      throw new Error(`Pan changed the immutable range or failed exact reconstruction: ${JSON.stringify(state)}`);
    }
    const expectedDensity = Math.min(state.eligibleRowCount, 7000);
    if (state.sampledPointCount !== expectedDensity) {
      throw new Error(`Panned range density mismatch: expected ${expectedDensity}, got ${state.sampledPointCount}`);
    }
    if (state.requestedRange.min < state.fullRange.min || state.requestedRange.max > state.fullRange.max) {
      throw new Error(`Panned range escaped its immutable full range: ${JSON.stringify(state)}`);
    }
  }
}

function compactState(state) {
  if (!state) {
    return null;
  }
  return {
    status: state.status,
    requestId: state.requestId,
    sourceRowCount: state.sourceRowCount,
    eligibleRowCount: state.eligibleRowCount,
    sampledPointCount: state.sampledPointCount,
    algorithm: state.algorithm,
    requestedRange: state.requestedRange,
    visibleRange: state.visibleRange,
    fullRange: state.fullRange,
  };
}

function compactFamilyState(state) {
  return {
    ...compactState(state),
    chartType: state.chartType,
    screenshotSha256: state.screenshotSha256,
    screenshotByteLength: state.screenshotByteLength,
    screenshotWidth: state.screenshotWidth,
    screenshotHeight: state.screenshotHeight,
  };
}

function rangeKey(range) {
  return range && Number.isFinite(range.min) && Number.isFinite(range.max)
    ? `${Number(range.min)}:${Number(range.max)}`
    : '';
}

function writeResult(resultPath, result) {
  const temporaryPath = `${resultPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(result, null, 2)}\n`);
  fs.renameSync(temporaryPath, resultPath);
}

async function waitForJson(filePath, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (error) {
        lastError = error.message;
      }
    }
    await delay(POLL_MS);
  }
  throw new Error(
    `Timed out waiting for ${label} at ${filePath}` +
    (lastError ? `: ${lastError}` : '')
  );
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.executionContexts = [];
    this.chartContextId = undefined;
    this.gridContextId = undefined;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.executionContextCreated' &&
        message.params && message.params.context) {
        this.executionContexts.push(message.params.context);
        return;
      }
      if (message.method === 'Runtime.executionContextDestroyed' && message.params) {
        this.executionContexts = this.executionContexts.filter(
          context => context.id !== message.params.executionContextId
        );
        if (this.chartContextId === message.params.executionContextId) {
          this.chartContextId = undefined;
        }
        if (this.gridContextId === message.params.executionContextId) {
          this.gridContextId = undefined;
        }
        return;
      }
      if (message.method === 'Runtime.executionContextsCleared') {
        this.executionContexts = [];
        this.chartContextId = undefined;
        this.gridContextId = undefined;
        return;
      }
      if (!message.id || !this.pending.has(message.id)) {
        return;
      }
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result || {});
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`CDP socket closed while waiting for ${pending.method}`));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to CDP target')), 5000);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Failed to connect to CDP target'));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

module.exports = {
  runVisualAcceptance,
};
