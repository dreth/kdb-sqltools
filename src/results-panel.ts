import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import JSZip = require('jszip');
import {
  CellRange,
  ExportFormat,
  RowValue,
  TextExportFormat,
  VisibleIndexRange,
  allCellsRange,
  cellValueToText,
  clampCellRange,
  rowsToCellWindow,
  rowsToTextFormat,
} from './kdb-results';

export interface KdbPanelResult {
  columns: string[];
  rows: RowValue[];
  query: string;
  connectionName: string;
  elapsedMs: number;
  messages: string[];
  error?: boolean;
}

interface LoadingState {
  query: string;
  connectionName: string;
}

interface KdbPanelMetadata {
  columns: string[];
  rowCount: number;
  query: string;
  connectionName: string;
  elapsedMs: number;
  messages: string[];
  error?: boolean;
  version: number;
  settings: KdbPanelSettings;
}

type KdbPanelDensity = 'compact' | 'standard' | 'comfortable';

interface KdbPanelSettings {
  cellWidth: number;
  rowHeight: number;
  fontSize: number;
  density: KdbPanelDensity;
}

const COPY_WARNING_BYTES = 15 * 1024 * 1024;
const DEFAULT_PANEL_SETTINGS: KdbPanelSettings = {
  cellWidth: 160,
  rowHeight: 28,
  fontSize: 0,
  density: 'standard',
};

export class KdbResultsPanel {
  private static current: KdbResultsPanel | undefined;
  private panel: vscode.WebviewPanel;
  private ready = false;
  private result: KdbPanelResult | undefined;
  private loading: LoadingState | undefined;
  private version = 0;

  public static showLoading(context: vscode.ExtensionContext, state: LoadingState): KdbResultsPanel {
    const panel = KdbResultsPanel.ensure(context);
    panel.version += 1;
    panel.loading = state;
    panel.result = undefined;
    panel.panel.reveal(vscode.ViewColumn.Beside);
    panel.post({ type: 'loading', state: { ...state, version: panel.version, settings: panelSettings() } });
    return panel;
  }

  public static showResult(context: vscode.ExtensionContext, result: KdbPanelResult): KdbResultsPanel {
    const panel = KdbResultsPanel.ensure(context);
    panel.version += 1;
    panel.loading = undefined;
    panel.result = result;
    panel.panel.reveal(vscode.ViewColumn.Beside);
    panel.postResultMetadata();
    return panel;
  }

  private static ensure(context: vscode.ExtensionContext): KdbResultsPanel {
    if (KdbResultsPanel.current) {
      return KdbResultsPanel.current;
    }

    KdbResultsPanel.current = new KdbResultsPanel(context);
    return KdbResultsPanel.current;
  }

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      'kdbSqltoolsResults',
      'kdb Results',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.onDidDispose(() => {
      KdbResultsPanel.current = undefined;
    }, undefined, this.context.subscriptions);
    this.panel.webview.onDidReceiveMessage(message => this.onMessage(message), undefined, this.context.subscriptions);
  }

  private async onMessage(message: any): Promise<void> {
    if (!message || typeof message.type !== 'string') {
      return;
    }

    if (message.type === 'ready') {
      this.ready = true;
      if (this.result) {
        this.postResultMetadata();
      } else if (this.loading) {
        this.post({ type: 'loading', state: { ...this.loading, version: this.version, settings: panelSettings() } });
      }
      return;
    }

    if (message.type === 'requestSlice') {
      this.postSlice(message);
      return;
    }

    if (message.type === 'copyRange') {
      await this.copyRange(message.range, textExportFormat(message.format), message.includeHeaders === true);
      return;
    }

    if (message.type === 'exportRange') {
      await this.exportRange(message.range, exportFormat(message.format), message.includeHeaders === true);
    }
  }

  private postResultMetadata(): void {
    if (!this.result) {
      return;
    }
    this.post({ type: 'resultMeta', result: this.metadataForResult(this.result) });
  }

  private metadataForResult(result: KdbPanelResult): KdbPanelMetadata {
    return {
      columns: result.columns,
      rowCount: result.rows.length,
      query: result.query,
      connectionName: result.connectionName,
      elapsedMs: result.elapsedMs,
      messages: result.messages,
      error: result.error,
      version: this.version,
      settings: panelSettings(),
    };
  }

  private postSlice(message: any): void {
    if (!this.result || Number(message.version) !== this.version) {
      return;
    }

    const rowRange = messageRange(message.rows, this.result.rows.length);
    const columnRange = messageRange(message.columns, this.result.columns.length);
    const slice = rowsToCellWindow(this.result.rows, this.result.columns, rowRange, columnRange);
    this.post({
      type: 'slice',
      version: this.version,
      requestId: Number(message.requestId || 0),
      slice,
    });
  }

  private async copyRange(range: any, format: TextExportFormat, includeHeaders: boolean): Promise<void> {
    if (!this.result) {
      return;
    }

    const clamped = this.actionRange(range);
    if (!clamped) {
      return;
    }

    const text = rowsToTextFormat(this.result.rows, this.result.columns, clamped, format, includeHeaders);
    if (Buffer.byteLength(text, 'utf8') > COPY_WARNING_BYTES) {
      const choice = await vscode.window.showWarningMessage(
        `Copy output is ${formatBytes(Buffer.byteLength(text, 'utf8'))}. Export instead?`,
        'Export',
        'Copy Anyway'
      );
      if (choice === 'Export') {
        await this.exportRange(clamped, format, includeHeaders);
        return;
      }
      if (choice !== 'Copy Anyway') {
        this.post({ type: 'copySkipped', format });
        return;
      }
    }

    await vscode.env.clipboard.writeText(text);
    const rows = clamped.endRow - clamped.startRow + 1;
    const columns = clamped.endColumn - clamped.startColumn + 1;
    this.post({ type: 'copied', rows, columns, format, includeHeaders });
  }

  private async exportRange(range: any, format: ExportFormat, includeHeaders: boolean): Promise<void> {
    if (!this.result) {
      return;
    }

    if (format === 'parquet') {
      await vscode.window.showInformationMessage('Parquet export is not available in this build.');
      this.post({ type: 'exportSkipped', format });
      return;
    }

    const clamped = this.actionRange(range);
    if (!clamped) {
      return;
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: defaultExportUri(format),
      filters: saveFilters(format),
      saveLabel: 'Export',
    });
    if (!uri) {
      this.post({ type: 'exportSkipped', format });
      return;
    }

    const content = format === 'xlsx'
      ? await rowsToXlsx(this.result.rows, this.result.columns, clamped, includeHeaders)
      : Buffer.from(rowsToTextFormat(this.result.rows, this.result.columns, clamped, format, includeHeaders), 'utf8');
    await vscode.workspace.fs.writeFile(uri, content);
    const rows = clamped.endRow - clamped.startRow + 1;
    const columns = clamped.endColumn - clamped.startColumn + 1;
    this.post({ type: 'exported', rows, columns, format, includeHeaders });
  }

  private actionRange(range: any): CellRange | null {
    if (!this.result) {
      return null;
    }

    const requested = messageCellRange(range) || allCellsRange(this.result.rows.length, this.result.columns.length);
    return clampCellRange(requested, this.result.rows.length, this.result.columns.length);
  }

  private post(message: any): void {
    if (this.ready) {
      this.panel.webview.postMessage(message);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = nonceValue();
    const cspSource = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}' 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>kdb Results</title>
  <style nonce="${nonce}">
    :root {
      --header-height: 32px;
      --row-height: 28px;
      --index-width: 64px;
      --cell-width: 160px;
      --panel-font-size: var(--vscode-font-size);
      --cell-padding-x: 8px;
    }
    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--panel-font-size);
    }
    body {
      display: flex;
      flex-direction: column;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 38px;
      padding: 0 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      box-sizing: border-box;
      white-space: nowrap;
      overflow: hidden;
    }
    button, select {
      height: 26px;
      font: inherit;
    }
    button {
      padding: 0 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 2px;
      cursor: pointer;
    }
    button:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    button:disabled, select:disabled, input:disabled {
      opacity: 0.5;
      cursor: default;
    }
    select {
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 2px;
    }
    .checkbox {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--vscode-descriptionForeground);
    }
    .summary, .selection, .status {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .status {
      color: var(--vscode-descriptionForeground);
    }
    .selection {
      margin-left: auto;
      color: var(--vscode-descriptionForeground);
    }
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-progressBar-background);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      flex: 0 0 auto;
    }
    .spinner[hidden] {
      display: none;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    .message {
      padding: 10px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
      white-space: pre-wrap;
      max-height: 80px;
      overflow: auto;
      box-sizing: border-box;
    }
    .message.error {
      color: var(--vscode-errorForeground);
    }
    #viewport {
      position: relative;
      flex: 1;
      overflow: auto;
      outline: none;
      user-select: none;
    }
    #canvas {
      position: relative;
      min-width: 100%;
    }
    .header {
      position: sticky;
      top: 0;
      z-index: 5;
      height: var(--header-height);
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
      box-sizing: border-box;
    }
    .row {
      position: absolute;
      height: var(--row-height);
      box-sizing: border-box;
    }
    .cell {
      position: absolute;
      height: var(--row-height);
      line-height: var(--row-height);
      box-sizing: border-box;
      padding: 0 var(--cell-padding-x);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      border-right: 1px solid var(--vscode-panel-border);
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .header .cell {
      height: var(--header-height);
      line-height: var(--header-height);
      font-weight: 600;
      background: var(--vscode-editorGroupHeader-tabsBackground);
    }
    .index {
      color: var(--vscode-descriptionForeground);
      text-align: right;
      background: var(--vscode-sideBar-background);
    }
    .selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .empty {
      padding: 16px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <select id="copyFormat" aria-label="Copy format" disabled>
      <option value="tsv">TSV</option>
      <option value="csv">CSV</option>
      <option value="json">JSON</option>
      <option value="ndjson">NDJSON</option>
      <option value="html">HTML</option>
    </select>
    <button id="copy" disabled>Copy</button>
    <select id="exportFormat" aria-label="Export format" disabled>
      <option value="tsv">TSV</option>
      <option value="csv">CSV</option>
      <option value="xlsx">XLSX</option>
      <option value="json">JSON</option>
      <option value="ndjson">NDJSON</option>
      <option value="html">HTML</option>
      <option value="parquet">Parquet</option>
    </select>
    <button id="export" disabled>Export</button>
    <label class="checkbox"><input id="includeHeaders" type="checkbox" checked disabled>Headers</label>
    <span id="spinner" class="spinner" hidden></span>
    <span id="summary" class="summary"></span>
    <span id="status" class="status"></span>
    <span id="selection" class="selection"></span>
  </div>
  <div id="message" class="message" hidden></div>
  <div id="viewport" tabindex="0">
    <div id="canvas">
      <div id="header" class="header" role="row"></div>
      <div id="rows"></div>
      <div id="empty" class="empty" hidden>0 rows</div>
    </div>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const INDEX_WIDTH = 64;
      const OVERSCAN_ROWS = 8;
      const OVERSCAN_COLUMNS = 2;
      const DEFAULT_SETTINGS = { cellWidth: 160, rowHeight: 28, fontSize: 0, density: 'standard' };
      const viewport = document.getElementById('viewport');
      const canvas = document.getElementById('canvas');
      const header = document.getElementById('header');
      const rowsLayer = document.getElementById('rows');
      const copyFormat = document.getElementById('copyFormat');
      const copyButton = document.getElementById('copy');
      const exportFormat = document.getElementById('exportFormat');
      const exportButton = document.getElementById('export');
      const includeHeaders = document.getElementById('includeHeaders');
      const spinner = document.getElementById('spinner');
      const summary = document.getElementById('summary');
      const status = document.getElementById('status');
      const selectionLabel = document.getElementById('selection');
      const message = document.getElementById('message');
      const empty = document.getElementById('empty');
      let data = emptyData();
      let slice = emptySlice();
      let dragging = false;
      let dragMode = '';
      let selection = null;
      let renderQueued = false;
      let latestRequestId = 0;
      let pendingRequestKey = '';
      let layout = layoutFromSettings(DEFAULT_SETTINGS);

      window.addEventListener('message', event => {
        const msg = event.data || {};
        if (msg.type === 'loading') {
          setLoading(msg.state || {});
        } else if (msg.type === 'resultMeta') {
          setResultMeta(msg.result || {});
        } else if (msg.type === 'slice') {
          setSlice(msg);
        } else if (msg.type === 'copied') {
          status.textContent = 'Copied ' + msg.rows + 'x' + msg.columns + ' ' + String(msg.format || '').toUpperCase();
        } else if (msg.type === 'exported') {
          status.textContent = 'Exported ' + msg.rows + 'x' + msg.columns + ' ' + String(msg.format || '').toUpperCase();
        } else if (msg.type === 'exportSkipped') {
          status.textContent = String(msg.format || '').toUpperCase() + ' export skipped';
        } else if (msg.type === 'copySkipped') {
          status.textContent = 'Copy skipped';
        }
      });

      copyButton.addEventListener('click', copySelection);
      exportButton.addEventListener('click', exportSelection);
      viewport.addEventListener('scroll', requestRender);
      window.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && hasTableCells()) {
          event.preventDefault();
          copySelection();
        }
      });
      window.addEventListener('mouseup', () => {
        dragging = false;
        dragMode = '';
      });
      window.addEventListener('resize', requestRender);

      function setLoading(state) {
        applySettings(state.settings);
        data = emptyData();
        data.version = toNonNegativeInteger(state.version, data.version + 1);
        data.query = state.query || '';
        data.connectionName = state.connectionName || '';
        resetWindowState();
        summary.textContent = 'Running on ' + (state.connectionName || 'kdb');
        status.textContent = '';
        selectionLabel.textContent = '';
        spinner.hidden = false;
        setActionsDisabled(true);
        showMessage('', false);
        renderNow();
      }

      function setResultMeta(result) {
        applySettings(result.settings);
        data = {
          version: toNonNegativeInteger(result.version, data.version + 1),
          columns: Array.isArray(result.columns) ? result.columns.map(String) : [],
          rowCount: toNonNegativeInteger(result.rowCount, 0),
          messages: Array.isArray(result.messages) ? result.messages.map(String) : [],
          query: result.query || '',
          connectionName: result.connectionName || '',
          elapsedMs: toNonNegativeInteger(result.elapsedMs, 0),
          error: !!result.error
        };
        resetWindowState();
        summary.textContent = data.rowCount + ' rows x ' + data.columns.length + ' columns' +
          (data.connectionName ? ' | ' + data.connectionName : '') +
          ' | ' + data.elapsedMs + ' ms';
        status.textContent = '';
        spinner.hidden = true;
        updateActionState();
        updateSelectionLabel();
        showMessage(data.messages.join('\\n'), data.error);
        renderNow();
      }

      function setSlice(msg) {
        if (toNonNegativeInteger(msg.version, -1) !== data.version) {
          return;
        }
        if (toNonNegativeInteger(msg.requestId, 0) < latestRequestId) {
          return;
        }
        slice = normalizeSlice(msg.slice || {});
        pendingRequestKey = '';
        renderNow();
      }

      function resetWindowState() {
        slice = emptySlice();
        selection = null;
        dragging = false;
        dragMode = '';
        latestRequestId = 0;
        pendingRequestKey = '';
      }

      function setActionsDisabled(disabled) {
        copyFormat.disabled = disabled;
        copyButton.disabled = disabled;
        exportFormat.disabled = disabled;
        exportButton.disabled = disabled;
        includeHeaders.disabled = disabled;
      }

      function updateActionState() {
        setActionsDisabled(!hasTableCells());
      }

      function hasTableCells() {
        return data.rowCount > 0 && data.columns.length > 0;
      }

      function applySettings(value) {
        const settings = normalizeSettings(value || {});
        layout = layoutFromSettings(settings);
        const root = document.documentElement;
        root.style.setProperty('--cell-width', layout.cellWidth + 'px');
        root.style.setProperty('--row-height', layout.rowHeight + 'px');
        root.style.setProperty('--header-height', layout.headerHeight + 'px');
        root.style.setProperty('--cell-padding-x', layout.cellPaddingX + 'px');
        root.style.setProperty('--panel-font-size', settings.fontSize > 0 ? settings.fontSize + 'px' : 'var(--vscode-font-size)');
      }

      function layoutFromSettings(settings) {
        const densityDelta = settings.density === 'compact' ? -4 : settings.density === 'comfortable' ? 4 : 0;
        const rowHeight = clampInteger(settings.rowHeight + densityDelta, 20, 80);
        return {
          cellWidth: settings.cellWidth,
          rowHeight,
          headerHeight: clampInteger(rowHeight + 4, 24, 88),
          cellPaddingX: settings.density === 'compact' ? 5 : settings.density === 'comfortable' ? 11 : 8
        };
      }

      function normalizeSettings(value) {
        return {
          cellWidth: boundedSetting(value.cellWidth, DEFAULT_SETTINGS.cellWidth, 80, 600),
          rowHeight: boundedSetting(value.rowHeight, DEFAULT_SETTINGS.rowHeight, 20, 80),
          fontSize: boundedSetting(value.fontSize, DEFAULT_SETTINGS.fontSize, 0, 32),
          density: normalizeDensity(value.density)
        };
      }

      function boundedSetting(value, fallback, min, max) {
        const number = Number(value);
        return Number.isFinite(number) ? clampInteger(number, min, max) : fallback;
      }

      function normalizeDensity(value) {
        return value === 'compact' || value === 'comfortable' ? value : 'standard';
      }

      function showMessage(text, isError) {
        message.hidden = !text;
        message.textContent = text || '';
        message.className = isError ? 'message error' : 'message';
      }

      function requestRender() {
        if (renderQueued) {
          return;
        }
        renderQueued = true;
        requestAnimationFrame(() => {
          renderQueued = false;
          renderNow();
        });
      }

      function renderNow() {
        const columnCount = data.columns.length;
        const rowCount = data.rowCount;
        const totalWidth = INDEX_WIDTH + columnCount * layout.cellWidth;
        const totalHeight = layout.headerHeight + rowCount * layout.rowHeight;
        canvas.style.width = Math.max(totalWidth, viewport.clientWidth) + 'px';
        canvas.style.height = Math.max(totalHeight, viewport.clientHeight) + 'px';
        empty.hidden = rowCount !== 0 || columnCount !== 0;
        empty.style.top = layout.headerHeight + 'px';

        const rows = visibleRange(Math.max(0, viewport.scrollTop - layout.headerHeight), viewport.clientHeight, layout.rowHeight, rowCount, OVERSCAN_ROWS);
        const columns = visibleColumns();
        renderHeader(columns);
        requestSlice(rows, columns);
        renderRows(rows, columns);
      }

      function visibleColumns() {
        const offset = Math.max(0, viewport.scrollLeft - INDEX_WIDTH);
        return visibleRange(offset, viewport.clientWidth, layout.cellWidth, data.columns.length, OVERSCAN_COLUMNS);
      }

      function visibleRange(offset, size, itemSize, count, overscan) {
        if (count <= 0 || size <= 0 || itemSize <= 0) {
          return { start: 0, end: -1 };
        }
        const start = Math.max(0, Math.floor(offset / itemSize) - overscan);
        const end = Math.min(count - 1, Math.ceil((offset + size) / itemSize) + overscan);
        return { start, end };
      }

      function requestSlice(rows, columns) {
        if (rows.end < rows.start || columns.end < columns.start || data.rowCount <= 0 || data.columns.length <= 0) {
          return;
        }
        if (sliceCovers(slice, rows, columns)) {
          return;
        }

        const key = rangeKey(rows, columns);
        if (pendingRequestKey === key) {
          return;
        }

        pendingRequestKey = key;
        latestRequestId += 1;
        vscode.postMessage({
          type: 'requestSlice',
          version: data.version,
          requestId: latestRequestId,
          rows,
          columns
        });
      }

      function renderHeader(columns) {
        const range = normalizedSelection();
        replaceChildren(header, [createCell({
          text: '#',
          row: -1,
          column: -1,
          left: 0,
          top: 0,
          width: INDEX_WIDTH,
          headerCell: true,
          selected: isAllSelected(range),
          className: 'cell index'
        })].concat(headerCells(columns, range)));
      }

      function headerCells(columns, range) {
        const cells = [];
        for (let column = columns.start; column <= columns.end; column++) {
          cells.push(createCell({
            text: data.columns[column],
            row: -1,
            column,
            left: INDEX_WIDTH + column * layout.cellWidth,
            top: 0,
            width: layout.cellWidth,
            headerCell: true,
            selected: isColumnSelected(column, range),
            className: 'cell'
          }));
        }
        return cells;
      }

      function renderRows(rows, columns) {
        const range = normalizedSelection();
        const hasCells = sliceCovers(slice, rows, columns);
        const fragment = document.createDocumentFragment();
        for (let row = rows.start; row <= rows.end; row++) {
          const rowElement = document.createElement('div');
          rowElement.className = 'row';
          rowElement.setAttribute('role', 'row');
          rowElement.style.top = (layout.headerHeight + row * layout.rowHeight) + 'px';
          rowElement.style.width = canvas.style.width;
          rowElement.appendChild(createCell({
            text: String(row + 1),
            row,
            column: -1,
            left: 0,
            top: 0,
            width: INDEX_WIDTH,
            headerCell: false,
            selected: isRowSelected(row, range),
            className: 'cell index'
          }));
          for (let column = columns.start; column <= columns.end; column++) {
            const selected = isSelected(row, column, range);
            const value = hasCells ? cellText(row, column) : '';
            rowElement.appendChild(createCell({
              text: value,
              row,
              column,
              left: INDEX_WIDTH + column * layout.cellWidth,
              top: 0,
              width: layout.cellWidth,
              headerCell: false,
              selected,
              className: 'cell'
            }));
          }
          fragment.appendChild(rowElement);
        }
        rowsLayer.textContent = '';
        rowsLayer.appendChild(fragment);
      }

      function createCell(options) {
        const cell = document.createElement('div');
        cell.className = options.className + (options.selected ? ' selected' : '');
        cell.setAttribute('role', options.row >= 0 && options.column < 0 ? 'rowheader' : options.headerCell ? 'columnheader' : 'cell');
        cell.style.left = options.left + 'px';
        cell.style.top = options.top + 'px';
        cell.style.width = options.width + 'px';
        cell.title = String(options.text || '');
        cell.textContent = String(options.text || '');
        if (options.row >= 0) {
          cell.dataset.row = String(options.row);
        }
        if (options.column >= 0) {
          cell.dataset.column = String(options.column);
        }
        if (options.row >= 0 && options.column >= 0) {
          cell.addEventListener('mousedown', onCellMouseDown);
          cell.addEventListener('mouseenter', onCellMouseEnter);
        } else if (options.row === -1 && options.column === -1) {
          cell.addEventListener('mousedown', onTableMouseDown);
        } else if (options.row === -1 && options.column >= 0) {
          cell.addEventListener('mousedown', onColumnMouseDown);
          cell.addEventListener('mouseenter', onColumnMouseEnter);
        } else if (options.row >= 0 && options.column === -1) {
          cell.addEventListener('mousedown', onRowMouseDown);
          cell.addEventListener('mouseenter', onRowMouseEnter);
        }
        return cell;
      }

      function onCellMouseDown(event) {
        if (event.button !== 0 || !hasTableCells()) {
          return;
        }
        const cell = event.currentTarget;
        const row = Number(cell.dataset.row);
        const column = Number(cell.dataset.column);
        dragging = true;
        dragMode = 'cell';
        if (event.shiftKey && selection) {
          selection.focusRow = row;
          selection.focusColumn = column;
        } else {
          selection = { anchorRow: row, anchorColumn: column, focusRow: row, focusColumn: column };
        }
        viewport.focus();
        updateSelection();
        event.preventDefault();
      }

      function onCellMouseEnter(event) {
        if (!dragging || dragMode !== 'cell' || !selection) {
          return;
        }
        const cell = event.currentTarget;
        selection.focusRow = Number(cell.dataset.row);
        selection.focusColumn = Number(cell.dataset.column);
        updateSelection();
      }

      function onColumnMouseDown(event) {
        if (event.button !== 0 || !hasTableCells()) {
          return;
        }
        const column = Number(event.currentTarget.dataset.column);
        const anchorColumn = event.shiftKey && selection ? selection.anchorColumn : column;
        dragging = true;
        dragMode = 'column';
        selection = { anchorRow: 0, anchorColumn, focusRow: data.rowCount - 1, focusColumn: column };
        viewport.focus();
        updateSelection();
        event.preventDefault();
      }

      function onColumnMouseEnter(event) {
        if (!dragging || dragMode !== 'column' || !selection) {
          return;
        }
        selection.focusRow = data.rowCount - 1;
        selection.focusColumn = Number(event.currentTarget.dataset.column);
        updateSelection();
      }

      function onRowMouseDown(event) {
        if (event.button !== 0 || !hasTableCells()) {
          return;
        }
        const row = Number(event.currentTarget.dataset.row);
        const anchorRow = event.shiftKey && selection ? selection.anchorRow : row;
        dragging = true;
        dragMode = 'row';
        selection = { anchorRow, anchorColumn: 0, focusRow: row, focusColumn: data.columns.length - 1 };
        viewport.focus();
        updateSelection();
        event.preventDefault();
      }

      function onRowMouseEnter(event) {
        if (!dragging || dragMode !== 'row' || !selection) {
          return;
        }
        selection.focusRow = Number(event.currentTarget.dataset.row);
        selection.focusColumn = data.columns.length - 1;
        updateSelection();
      }

      function onTableMouseDown(event) {
        if (event.button !== 0 || !hasTableCells()) {
          return;
        }
        dragging = false;
        dragMode = '';
        selection = { anchorRow: 0, anchorColumn: 0, focusRow: data.rowCount - 1, focusColumn: data.columns.length - 1 };
        viewport.focus();
        updateSelection();
        event.preventDefault();
      }

      function replaceChildren(element, children) {
        element.textContent = '';
        const fragment = document.createDocumentFragment();
        children.forEach(child => fragment.appendChild(child));
        element.appendChild(fragment);
      }

      function cellText(row, column) {
        const rowOffset = row - slice.startRow;
        const columnOffset = column - slice.startColumn;
        const rowCells = slice.cells[rowOffset] || [];
        return rowCells[columnOffset] || '';
      }

      function updateSelection() {
        status.textContent = '';
        updateActionState();
        updateSelectionLabel();
        renderNow();
      }

      function updateSelectionLabel() {
        const range = normalizedSelection();
        selectionLabel.textContent = range ? selectionText(range) : 'No selection (actions use all)';
      }

      function normalizedSelection() {
        if (!selection || !hasTableCells()) {
          return null;
        }
        const maxRow = data.rowCount - 1;
        const maxColumn = data.columns.length - 1;
        const range = {
          startRow: clampInteger(Math.min(selection.anchorRow, selection.focusRow), 0, maxRow),
          endRow: clampInteger(Math.max(selection.anchorRow, selection.focusRow), 0, maxRow),
          startColumn: clampInteger(Math.min(selection.anchorColumn, selection.focusColumn), 0, maxColumn),
          endColumn: clampInteger(Math.max(selection.anchorColumn, selection.focusColumn), 0, maxColumn)
        };
        return range.startRow <= range.endRow && range.startColumn <= range.endColumn ? range : null;
      }

      function isSelected(row, column, range) {
        return !!range &&
          row >= range.startRow &&
          row <= range.endRow &&
          column >= range.startColumn &&
          column <= range.endColumn;
      }

      function isAllSelected(range) {
        return !!range &&
          range.startRow === 0 &&
          range.endRow === data.rowCount - 1 &&
          range.startColumn === 0 &&
          range.endColumn === data.columns.length - 1;
      }

      function isColumnSelected(column, range) {
        return !!range &&
          column >= range.startColumn &&
          column <= range.endColumn &&
          range.startRow === 0 &&
          range.endRow === data.rowCount - 1;
      }

      function isRowSelected(row, range) {
        return !!range &&
          row >= range.startRow &&
          row <= range.endRow &&
          range.startColumn === 0 &&
          range.endColumn === data.columns.length - 1;
      }

      function selectionText(range) {
        const selectedRows = range.endRow - range.startRow + 1;
        const selectedColumns = range.endColumn - range.startColumn + 1;
        const fullRows = range.startRow === 0 && range.endRow === data.rowCount - 1;
        const fullColumns = range.startColumn === 0 && range.endColumn === data.columns.length - 1;
        if (fullRows && fullColumns) {
          return 'All ' + data.rowCount + 'x' + data.columns.length;
        }
        if (fullRows) {
          return selectedColumns === 1
            ? 'Column ' + (range.startColumn + 1)
            : 'Columns ' + (range.startColumn + 1) + '-' + (range.endColumn + 1);
        }
        if (fullColumns) {
          return selectedRows === 1
            ? 'Row ' + (range.startRow + 1)
            : 'Rows ' + (range.startRow + 1) + '-' + (range.endRow + 1);
        }
        return 'Range ' + selectedRows + 'x' + selectedColumns;
      }

      function copySelection() {
        if (!hasTableCells()) {
          return;
        }
        const range = normalizedSelection();
        vscode.postMessage({
          type: 'copyRange',
          range,
          format: String(copyFormat.value || 'tsv'),
          includeHeaders: !!includeHeaders.checked
        });
      }

      function exportSelection() {
        if (!hasTableCells()) {
          return;
        }
        const range = normalizedSelection();
        vscode.postMessage({
          type: 'exportRange',
          range,
          format: String(exportFormat.value || 'tsv'),
          includeHeaders: !!includeHeaders.checked
        });
      }

      function sliceCovers(value, rows, columns) {
        return value &&
          rows.start >= value.startRow &&
          rows.end <= value.endRow &&
          columns.start >= value.startColumn &&
          columns.end <= value.endColumn;
      }

      function rangeKey(rows, columns) {
        return rows.start + ':' + rows.end + ':' + columns.start + ':' + columns.end;
      }

      function normalizeSlice(value) {
        const cells = Array.isArray(value.cells) ? value.cells : [];
        return {
          startRow: toNonNegativeInteger(value.startRow, 0),
          endRow: toInteger(value.endRow, -1),
          startColumn: toNonNegativeInteger(value.startColumn, 0),
          endColumn: toInteger(value.endColumn, -1),
          cells: cells.map(row => Array.isArray(row) ? row.map(cell => cell === null || cell === undefined ? '' : String(cell)) : [])
        };
      }

      function emptyData() {
        return {
          version: 0,
          columns: [],
          rowCount: 0,
          messages: [],
          query: '',
          connectionName: '',
          elapsedMs: 0,
          error: false
        };
      }

      function emptySlice() {
        return {
          startRow: 0,
          endRow: -1,
          startColumn: 0,
          endColumn: -1,
          cells: []
        };
      }

      function toNonNegativeInteger(value, fallback) {
        return Math.max(0, toInteger(value, fallback));
      }

      function toInteger(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.floor(number) : fallback;
      }

      function clampInteger(value, min, max) {
        return Math.min(Math.max(Math.floor(value), min), max);
      }

      vscode.postMessage({ type: 'ready' });
    }());
  </script>
</body>
</html>`;
  }
}

function nonceValue(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function panelSettings(): KdbPanelSettings {
  const config = vscode.workspace.getConfiguration('kdb-sqltools.results');
  return {
    cellWidth: boundedSettingNumber(config.get<number>('cellWidth'), DEFAULT_PANEL_SETTINGS.cellWidth, 80, 600),
    rowHeight: boundedSettingNumber(config.get<number>('rowHeight'), DEFAULT_PANEL_SETTINGS.rowHeight, 20, 80),
    fontSize: boundedSettingNumber(config.get<number>('fontSize'), DEFAULT_PANEL_SETTINGS.fontSize, 0, 32),
    density: panelDensity(config.get<string>('density')),
  };
}

function boundedSettingNumber(value: any, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(number), min), max);
}

function panelDensity(value: any): KdbPanelDensity {
  return value === 'compact' || value === 'comfortable' ? value : 'standard';
}

function messageRange(value: any, itemCount: number): VisibleIndexRange {
  if (itemCount <= 0) {
    return { start: 0, end: -1 };
  }

  const max = itemCount - 1;
  const start = boundedInteger(value && value.start, 0, max);
  const end = boundedInteger(value && value.end, 0, max);
  if (start > end) {
    return { start: 0, end: -1 };
  }

  return { start, end };
}

function boundedInteger(value: any, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.min(Math.max(Math.floor(number), min), max);
}

function messageCellRange(value: any): CellRange | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const startRow = integerOrNull(value.startRow);
  const endRow = integerOrNull(value.endRow);
  const startColumn = integerOrNull(value.startColumn);
  const endColumn = integerOrNull(value.endColumn);
  if (startRow === null || endRow === null || startColumn === null || endColumn === null) {
    return null;
  }

  return { startRow, endRow, startColumn, endColumn };
}

function integerOrNull(value: any): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

function textExportFormat(value: any): TextExportFormat {
  switch (value) {
    case 'csv':
    case 'json':
    case 'ndjson':
    case 'html':
    case 'tsv':
      return value;
  }
  return 'tsv';
}

function exportFormat(value: any): ExportFormat {
  switch (value) {
    case 'csv':
    case 'xlsx':
    case 'json':
    case 'ndjson':
    case 'html':
    case 'parquet':
    case 'tsv':
      return value;
  }
  return 'tsv';
}

function saveFilters(format: ExportFormat): { [name: string]: string[] } {
  switch (format) {
    case 'csv':
      return { CSV: ['csv'] };
    case 'xlsx':
      return { XLSX: ['xlsx'] };
    case 'json':
      return { JSON: ['json'] };
    case 'ndjson':
      return { NDJSON: ['ndjson'] };
    case 'html':
      return { HTML: ['html', 'htm'] };
    case 'parquet':
      return { Parquet: ['parquet'] };
    case 'tsv':
      return { TSV: ['tsv'] };
  }
}

function defaultExportUri(format: ExportFormat): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : os.homedir();
  return vscode.Uri.file(path.join(folder, `kdb-results.${format}`));
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function rowsToXlsx(
  rows: RowValue[],
  columns: string[],
  range: CellRange,
  includeHeaders: boolean
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', xmlDeclaration() +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>');
  zip.file('_rels/.rels', xmlDeclaration() +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>');
  zip.file('xl/workbook.xml', xmlDeclaration() +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets>' +
    '</workbook>');
  zip.file('xl/_rels/workbook.xml.rels', xmlDeclaration() +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>');
  zip.file('xl/styles.xml', stylesXml());
  zip.file('xl/worksheets/sheet1.xml', sheetXml(rows, columns, range, includeHeaders));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

function sheetXml(rows: RowValue[], columns: string[], range: CellRange, includeHeaders: boolean): string {
  const selectedRows = range.endRow - range.startRow + 1;
  const selectedColumns = range.endColumn - range.startColumn + 1;
  const outputRows = selectedRows + (includeHeaders ? 1 : 0);
  const dimension = `A1:${excelColumnName(selectedColumns - 1)}${Math.max(outputRows, 1)}`;
  return xmlDeclaration() +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="${dimension}"/>` +
    '<sheetData>' +
    sheetRowsXml(rows, columns, range, includeHeaders) +
    '</sheetData>' +
    '</worksheet>';
}

function sheetRowsXml(rows: RowValue[], columns: string[], range: CellRange, includeHeaders: boolean): string {
  const parts: string[] = [];
  let outputRow = 1;
  if (includeHeaders) {
    const headers: string[] = [];
    for (let columnIndex = range.startColumn; columnIndex <= range.endColumn; columnIndex++) {
      headers.push(cellValueToText(columns[columnIndex]));
    }
    parts.push(sheetRowXml(outputRow, headers));
    outputRow += 1;
  }

  for (let rowIndex = range.startRow; rowIndex <= range.endRow; rowIndex++) {
    const row = rows[rowIndex] || {};
    const values: string[] = [];
    for (let columnIndex = range.startColumn; columnIndex <= range.endColumn; columnIndex++) {
      values.push(cellValueToText(row[columns[columnIndex]]));
    }
    parts.push(sheetRowXml(outputRow, values));
    outputRow += 1;
  }
  return parts.join('');
}

function sheetRowXml(rowNumber: number, values: string[]): string {
  const parts = [`<row r="${rowNumber}">`];
  for (let columnIndex = 0; columnIndex < values.length; columnIndex++) {
    parts.push(textCellXml(excelCellRef(columnIndex, rowNumber), values[columnIndex]));
  }
  parts.push('</row>');
  return parts.join('');
}

function textCellXml(ref: string, value: string): string {
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function excelCellRef(columnIndex: number, rowNumber: number): string {
  return `${excelColumnName(columnIndex)}${rowNumber}`;
}

function excelColumnName(columnIndex: number): string {
  let value = columnIndex + 1;
  let name = '';
  while (value > 0) {
    const modulo = (value - 1) % 26;
    name = String.fromCharCode(65 + modulo) + name;
    value = Math.floor((value - modulo) / 26);
  }
  return name;
}

function stylesXml(): string {
  return xmlDeclaration() +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}

function xmlDeclaration(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, char => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case '\'':
        return '&apos;';
    }
    return char;
  });
}
