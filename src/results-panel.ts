import * as vscode from 'vscode';
import { CellRange, RowValue, VisibleIndexRange, clampCellRange, rowsToCellWindow, rowsToTsv } from './kdb-results';

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
}

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
    panel.post({ type: 'loading', state: { ...state, version: panel.version } });
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
        this.post({ type: 'loading', state: { ...this.loading, version: this.version } });
      }
      return;
    }

    if (message.type === 'requestSlice') {
      this.postSlice(message);
      return;
    }

    if (message.type === 'copyRange') {
      await this.copyRange(message.range, message.includeHeaders === true);
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

  private async copyRange(range: CellRange, includeHeaders: boolean): Promise<void> {
    if (!this.result || !range) {
      return;
    }

    const clamped = clampCellRange(range, this.result.rows.length, this.result.columns.length);
    if (!clamped) {
      return;
    }

    const text = rowsToTsv(this.result.rows, this.result.columns, clamped, includeHeaders);
    await vscode.env.clipboard.writeText(text);
    const rows = clamped.endRow - clamped.startRow + 1;
    const columns = clamped.endColumn - clamped.startColumn + 1;
    this.post({ type: 'copied', rows, columns, includeHeaders });
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
    }
    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
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
    }
    button {
      height: 26px;
      padding: 0 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 2px;
      cursor: pointer;
      font: inherit;
    }
    button:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .summary, .selection {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .selection {
      margin-left: auto;
      color: var(--vscode-descriptionForeground);
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
      padding: 0 8px;
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
    <button id="copy" disabled>Copy TSV</button>
    <button id="copyHeaders" disabled>Copy TSV + Headers</button>
    <span id="summary" class="summary"></span>
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
      const ROW_HEIGHT = 28;
      const HEADER_HEIGHT = 32;
      const INDEX_WIDTH = 64;
      const CELL_WIDTH = 160;
      const OVERSCAN_ROWS = 8;
      const OVERSCAN_COLUMNS = 2;
      const viewport = document.getElementById('viewport');
      const canvas = document.getElementById('canvas');
      const header = document.getElementById('header');
      const rowsLayer = document.getElementById('rows');
      const copyButton = document.getElementById('copy');
      const copyHeadersButton = document.getElementById('copyHeaders');
      const summary = document.getElementById('summary');
      const selectionLabel = document.getElementById('selection');
      const message = document.getElementById('message');
      const empty = document.getElementById('empty');
      let data = emptyData();
      let slice = emptySlice();
      let dragging = false;
      let selection = null;
      let renderQueued = false;
      let latestRequestId = 0;
      let pendingRequestKey = '';

      window.addEventListener('message', event => {
        const msg = event.data || {};
        if (msg.type === 'loading') {
          setLoading(msg.state || {});
        } else if (msg.type === 'resultMeta') {
          setResultMeta(msg.result || {});
        } else if (msg.type === 'slice') {
          setSlice(msg);
        } else if (msg.type === 'copied') {
          selectionLabel.textContent = 'Copied ' + msg.rows + 'x' + msg.columns +
            (msg.includeHeaders ? ' with headers' : '');
        }
      });

      copyButton.addEventListener('click', () => copySelection(false));
      copyHeadersButton.addEventListener('click', () => copySelection(true));
      viewport.addEventListener('scroll', requestRender);
      viewport.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && selection) {
          event.preventDefault();
          copySelection(false);
        }
      });
      window.addEventListener('mouseup', () => {
        dragging = false;
      });
      window.addEventListener('resize', requestRender);

      function setLoading(state) {
        data = emptyData();
        data.version = toNonNegativeInteger(state.version, data.version + 1);
        data.query = state.query || '';
        data.connectionName = state.connectionName || '';
        resetWindowState();
        summary.textContent = 'Running on ' + (state.connectionName || 'kdb');
        selectionLabel.textContent = '';
        setCopyDisabled(true);
        showMessage('', false);
        renderNow();
      }

      function setResultMeta(result) {
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
        selectionLabel.textContent = '';
        setCopyDisabled(true);
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
        latestRequestId = 0;
        pendingRequestKey = '';
      }

      function setCopyDisabled(disabled) {
        copyButton.disabled = disabled;
        copyHeadersButton.disabled = disabled;
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
        const totalWidth = INDEX_WIDTH + columnCount * CELL_WIDTH;
        const totalHeight = HEADER_HEIGHT + rowCount * ROW_HEIGHT;
        canvas.style.width = Math.max(totalWidth, viewport.clientWidth) + 'px';
        canvas.style.height = Math.max(totalHeight, viewport.clientHeight) + 'px';
        empty.hidden = rowCount !== 0 || columnCount !== 0;
        empty.style.top = HEADER_HEIGHT + 'px';

        const rows = visibleRange(Math.max(0, viewport.scrollTop - HEADER_HEIGHT), viewport.clientHeight, ROW_HEIGHT, rowCount, OVERSCAN_ROWS);
        const columns = visibleColumns();
        renderHeader(columns);
        requestSlice(rows, columns);
        renderRows(rows, columns);
      }

      function visibleColumns() {
        const offset = Math.max(0, viewport.scrollLeft - INDEX_WIDTH);
        return visibleRange(offset, viewport.clientWidth, CELL_WIDTH, data.columns.length, OVERSCAN_COLUMNS);
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
        replaceChildren(header, [createCell({
          text: '#',
          row: -1,
          column: -1,
          left: 0,
          top: 0,
          width: INDEX_WIDTH,
          headerCell: true,
          selected: false,
          className: 'cell index'
        })].concat(headerCells(columns)));
      }

      function headerCells(columns) {
        const cells = [];
        for (let column = columns.start; column <= columns.end; column++) {
          cells.push(createCell({
            text: data.columns[column],
            row: -1,
            column,
            left: INDEX_WIDTH + column * CELL_WIDTH,
            top: 0,
            width: CELL_WIDTH,
            headerCell: true,
            selected: false,
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
          rowElement.style.top = (HEADER_HEIGHT + row * ROW_HEIGHT) + 'px';
          rowElement.style.width = canvas.style.width;
          rowElement.appendChild(createCell({
            text: String(row + 1),
            row,
            column: -1,
            left: 0,
            top: 0,
            width: INDEX_WIDTH,
            headerCell: false,
            selected: false,
            className: 'cell index'
          }));
          for (let column = columns.start; column <= columns.end; column++) {
            const selected = isSelected(row, column, range);
            const value = hasCells ? cellText(row, column) : '';
            rowElement.appendChild(createCell({
              text: value,
              row,
              column,
              left: INDEX_WIDTH + column * CELL_WIDTH,
              top: 0,
              width: CELL_WIDTH,
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
        cell.setAttribute('role', options.headerCell ? 'columnheader' : 'cell');
        cell.style.left = options.left + 'px';
        cell.style.top = options.top + 'px';
        cell.style.width = options.width + 'px';
        cell.title = String(options.text || '');
        cell.textContent = String(options.text || '');
        if (options.row >= 0 && options.column >= 0) {
          cell.dataset.row = String(options.row);
          cell.dataset.column = String(options.column);
          cell.addEventListener('mousedown', onCellMouseDown);
          cell.addEventListener('mouseenter', onCellMouseEnter);
        }
        return cell;
      }

      function onCellMouseDown(event) {
        const cell = event.currentTarget;
        const row = Number(cell.dataset.row);
        const column = Number(cell.dataset.column);
        dragging = true;
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
        if (!dragging || !selection) {
          return;
        }
        const cell = event.currentTarget;
        selection.focusRow = Number(cell.dataset.row);
        selection.focusColumn = Number(cell.dataset.column);
        updateSelection();
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
        const range = normalizedSelection();
        if (!range) {
          selectionLabel.textContent = '';
          setCopyDisabled(true);
        } else {
          const selectedRows = range.endRow - range.startRow + 1;
          const selectedColumns = range.endColumn - range.startColumn + 1;
          selectionLabel.textContent = 'R' + (range.startRow + 1) + 'C' + (range.startColumn + 1) +
            ':R' + (range.endRow + 1) + 'C' + (range.endColumn + 1) +
            ' (' + selectedRows + 'x' + selectedColumns + ')';
          setCopyDisabled(false);
        }
        renderNow();
      }

      function normalizedSelection() {
        if (!selection) {
          return null;
        }
        return {
          startRow: Math.min(selection.anchorRow, selection.focusRow),
          endRow: Math.max(selection.anchorRow, selection.focusRow),
          startColumn: Math.min(selection.anchorColumn, selection.focusColumn),
          endColumn: Math.max(selection.anchorColumn, selection.focusColumn)
        };
      }

      function isSelected(row, column, range) {
        return !!range &&
          row >= range.startRow &&
          row <= range.endRow &&
          column >= range.startColumn &&
          column <= range.endColumn;
      }

      function copySelection(includeHeaders) {
        const range = normalizedSelection();
        if (range) {
          vscode.postMessage({ type: 'copyRange', range, includeHeaders: !!includeHeaders });
        }
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
