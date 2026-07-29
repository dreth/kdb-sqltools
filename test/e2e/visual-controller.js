const fs = require('fs');
const path = require('path');

const POLL_MS = 200;
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
      const first = await dragAndWaitForRefinement(session, initial, 0.12, 0.82, 'first drag zoom');
      const second = await dragAndWaitForRefinement(session, first, 0.25, 0.72, 'nested drag zoom');

      assertVisualEvidence(initial, first, second);
      const screenshot = await session.root.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
      if (screenshot && typeof screenshot.data === 'string') {
        fs.writeFileSync(path.join(controlDir, 'nested-zoom.png'), Buffer.from(screenshot.data, 'base64'));
      }
      writeResult(resultPath, {
        ok: true,
        initial: compactState(initial),
        first: compactState(first),
        second: compactState(second),
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
    assertUncheckedAutoFit(initial);
    const fallbackWidth = initial.cellWidth;
    const initialWidths = assertAllRenderedColumns(initial, fallbackWidth);

    const uncheckedBottom = await scrollGridTo(session, 'bottom');
    assertUncheckedAutoFit(uncheckedBottom);
    if (uncheckedBottom.rowRange.max !== 239) {
      throw new Error(`Unchecked grid did not virtual-scroll to row 239: ${JSON.stringify(uncheckedBottom.rowRange)}`);
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
    headerCells.forEach(cell => {
      const column = Number(cell.dataset.column);
      headers[column] = String(cell.childNodes[0] && cell.childNodes[0].textContent || '').trim();
      headerWidths[column] = width(cell);
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
    return {
      summary: String(summary.textContent || ''),
      headers,
      headerWidths,
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
    headerWidths: state.headerWidths,
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
    second.eligibleRowCount >= 3000)) {
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
