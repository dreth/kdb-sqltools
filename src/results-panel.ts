import * as vscode from 'vscode';
import { CellRange, RowValue, clampCellRange, rowsToTsv } from './kdb-results';

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

export class KdbResultsPanel {
  private static current: KdbResultsPanel | undefined;
  private panel: vscode.WebviewPanel;
  private ready = false;
  private result: KdbPanelResult | undefined;
  private loading: LoadingState | undefined;

  public static showLoading(context: vscode.ExtensionContext, state: LoadingState): KdbResultsPanel {
    const panel = KdbResultsPanel.ensure(context);
    panel.loading = state;
    panel.result = undefined;
    panel.panel.reveal(vscode.ViewColumn.Beside);
    panel.post({ type: 'loading', state });
    return panel;
  }

  public static showResult(context: vscode.ExtensionContext, result: KdbPanelResult): KdbResultsPanel {
    const panel = KdbResultsPanel.ensure(context);
    panel.loading = undefined;
    panel.result = result;
    panel.panel.reveal(vscode.ViewColumn.Beside);
    panel.post({ type: 'result', result });
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
        this.post({ type: 'result', result: this.result });
      } else if (this.loading) {
        this.post({ type: 'loading', state: this.loading });
      }
      return;
    }

    if (message.type === 'copyRange') {
      await this.copyRange(message.range);
    }
  }

  private async copyRange(range: CellRange): Promise<void> {
    if (!this.result || !range) {
      return;
    }

    const clamped = clampCellRange(range, this.result.rows.length, this.result.columns.length);
    if (!clamped) {
      return;
    }

    const text = rowsToTsv(this.result.rows, this.result.columns, clamped);
    await vscode.env.clipboard.writeText(text);
    const rows = clamped.endRow - clamped.startRow + 1;
    const columns = clamped.endColumn - clamped.startColumn + 1;
    this.post({ type: 'copied', rows, columns });
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
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
      const summary = document.getElementById('summary');
      const selectionLabel = document.getElementById('selection');
      const message = document.getElementById('message');
      const empty = document.getElementById('empty');
      let data = { columns: [], rows: [], messages: [], query: '', connectionName: '', elapsedMs: 0 };
      let dragging = false;
      let selection = null;
      let renderQueued = false;

      window.addEventListener('message', event => {
        const msg = event.data || {};
        if (msg.type === 'loading') {
          setLoading(msg.state || {});
        } else if (msg.type === 'result') {
          setResult(msg.result || {});
        } else if (msg.type === 'copied') {
          selectionLabel.textContent = 'Copied ' + msg.rows + 'x' + msg.columns;
        }
      });

      copyButton.addEventListener('click', copySelection);
      viewport.addEventListener('scroll', requestRender);
      viewport.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && selection) {
          event.preventDefault();
          copySelection();
        }
      });
      window.addEventListener('mouseup', () => {
        dragging = false;
      });
      window.addEventListener('resize', requestRender);

      function setLoading(state) {
        data = { columns: [], rows: [], messages: [], query: state.query || '', connectionName: state.connectionName || '', elapsedMs: 0 };
        selection = null;
        summary.textContent = 'Running on ' + (state.connectionName || 'kdb');
        selectionLabel.textContent = '';
        copyButton.disabled = true;
        showMessage('', false);
        renderNow();
      }

      function setResult(result) {
        data = {
          columns: Array.isArray(result.columns) ? result.columns : [],
          rows: Array.isArray(result.rows) ? result.rows : [],
          messages: Array.isArray(result.messages) ? result.messages : [],
          query: result.query || '',
          connectionName: result.connectionName || '',
          elapsedMs: Number(result.elapsedMs || 0)
        };
        selection = null;
        copyButton.disabled = true;
        summary.textContent = data.rows.length + ' rows x ' + data.columns.length + ' columns' +
          (data.connectionName ? ' | ' + data.connectionName : '') +
          ' | ' + data.elapsedMs + ' ms';
        selectionLabel.textContent = '';
        showMessage(data.messages.join('\\n'), !!result.error);
        renderNow();
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
        const rowCount = data.rows.length;
        const totalWidth = INDEX_WIDTH + columnCount * CELL_WIDTH;
        const totalHeight = HEADER_HEIGHT + rowCount * ROW_HEIGHT;
        canvas.style.width = Math.max(totalWidth, viewport.clientWidth) + 'px';
        canvas.style.height = Math.max(totalHeight, viewport.clientHeight) + 'px';
        empty.hidden = rowCount !== 0 || columnCount !== 0;
        empty.style.top = HEADER_HEIGHT + 'px';

        const rows = visibleRange(Math.max(0, viewport.scrollTop - HEADER_HEIGHT), viewport.clientHeight, ROW_HEIGHT, rowCount, OVERSCAN_ROWS);
        const columns = visibleColumns();
        renderHeader(columns);
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

      function renderHeader(columns) {
        const parts = [cellHtml('#', -1, -1, 0, 0, INDEX_WIDTH, true, false, 'cell index')];
        for (let column = columns.start; column <= columns.end; column++) {
          parts.push(cellHtml(data.columns[column], -1, column, INDEX_WIDTH + column * CELL_WIDTH, 0, CELL_WIDTH, true, false, 'cell'));
        }
        header.innerHTML = parts.join('');
      }

      function renderRows(rows, columns) {
        const parts = [];
        const range = normalizedSelection();
        for (let row = rows.start; row <= rows.end; row++) {
          const top = HEADER_HEIGHT + row * ROW_HEIGHT;
          parts.push('<div class="row" role="row" style="top:' + top + 'px;width:' + canvas.style.width + '">');
          parts.push(cellHtml(String(row + 1), row, -1, 0, 0, INDEX_WIDTH, false, false, 'cell index'));
          const rowData = data.rows[row] || {};
          for (let column = columns.start; column <= columns.end; column++) {
            const selected = isSelected(row, column, range);
            const value = formatValue(rowData[data.columns[column]]);
            parts.push(cellHtml(value, row, column, INDEX_WIDTH + column * CELL_WIDTH, 0, CELL_WIDTH, false, selected, 'cell'));
          }
          parts.push('</div>');
        }
        rowsLayer.innerHTML = parts.join('');
        rowsLayer.querySelectorAll('[data-row][data-column]').forEach(el => {
          el.addEventListener('mousedown', event => {
            const cell = event.currentTarget;
            const row = Number(cell.dataset.row);
            const column = Number(cell.dataset.column);
            dragging = true;
            selection = { anchorRow: row, anchorColumn: column, focusRow: row, focusColumn: column };
            viewport.focus();
            updateSelection();
            event.preventDefault();
          });
          el.addEventListener('mouseenter', event => {
            if (!dragging || !selection) {
              return;
            }
            const cell = event.currentTarget;
            selection.focusRow = Number(cell.dataset.row);
            selection.focusColumn = Number(cell.dataset.column);
            updateSelection();
          });
        });
      }

      function cellHtml(text, row, column, left, top, width, headerCell, selected, className) {
        const attrs = row >= 0 && column >= 0 ? ' data-row="' + row + '" data-column="' + column + '"' : '';
        const role = headerCell ? 'columnheader' : 'cell';
        const selectedClass = selected ? ' selected' : '';
        return '<div class="' + className + selectedClass + '" role="' + role + '"' + attrs +
          ' style="left:' + left + 'px;top:' + top + 'px;width:' + width + 'px" title="' + escapeAttr(text) + '">' +
          escapeHtml(text) + '</div>';
      }

      function updateSelection() {
        const range = normalizedSelection();
        if (!range) {
          selectionLabel.textContent = '';
          copyButton.disabled = true;
        } else {
          selectionLabel.textContent = 'R' + (range.startRow + 1) + 'C' + (range.startColumn + 1) +
            ':R' + (range.endRow + 1) + 'C' + (range.endColumn + 1);
          copyButton.disabled = false;
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

      function copySelection() {
        const range = normalizedSelection();
        if (range) {
          vscode.postMessage({ type: 'copyRange', range });
        }
      }

      function formatValue(value) {
        if (value === null || value === undefined) {
          return '';
        }
        if (typeof value === 'object') {
          try {
            return JSON.stringify(value);
          } catch (_error) {
            return String(value);
          }
        }
        return String(value);
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      function escapeAttr(value) {
        return escapeHtml(value).replace(/"/g, '&quot;');
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
