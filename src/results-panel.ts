import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import JSZip = require('jszip');
import {
  CellRange,
  ColumnarPanelResult,
  ExportFormat,
  TextExportFormat,
  VisibleIndexRange,
  allCellsRange,
  applyColumnarRowOrder,
  cellValueToText,
  clampCellRange,
  exportShape,
  filterColumnarPanelResult,
  rowIndexColumnName,
  sortedColumnarRowOrder,
  validateXlsxSheetLimits,
} from './kdb-results';
import { endPerfSpan, isPerfTraceEnabled, perfSpan } from './perf';

export interface KdbPanelResult {
  table: ColumnarPanelResult;
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
  allColumns: string[];
  hiddenColumnCount: number;
  hiddenColumnNames: string[];
  rowCount: number;
  query: string;
  connectionName: string;
  elapsedMs: number;
  messages: string[];
  error?: boolean;
  version: number;
  settings: KdbPanelSettings;
  sort: KdbPanelSortState | null;
  guardrailMessage?: string;
}

type KdbPanelDensity = 'compact' | 'standard' | 'comfortable';
type KdbPanelElapsedTimeDisplay = 'auto' | 'milliseconds';
type KdbPanelSortDirection = 'asc' | 'desc';
export type KdbResultsPanelRunMode = 'replace' | 'new';

interface KdbPanelSortState {
  columnName: string;
  direction: KdbPanelSortDirection;
}

interface KdbPanelSettings {
  cellWidth: number;
  rowHeight: number;
  fontSize: number;
  density: KdbPanelDensity;
  showRowIndex: boolean;
  includeHeaders: boolean;
  includeRowIndex: boolean;
  hideLargeResultWarnings: boolean;
  hideLargeSortWarnings: boolean;
  elapsedTimeDisplay: KdbPanelElapsedTimeDisplay;
}

interface CopyExportEstimate {
  selectedRows: number;
  selectedColumns: number;
  outputRows: number;
  outputColumns: number;
  selectedCells: number;
  outputCells: number;
  estimatedBytes: number;
}

const COPY_WARNING_BYTES = 15 * 1024 * 1024;
const LARGE_RESULT_WARNING_CELL_THRESHOLD = 5 * 1000 * 1000;
const LARGE_RESULT_WARNING_ROW_THRESHOLD = 1000000;
const LARGE_RESULT_WARNING_COLUMN_THRESHOLD = 500;
const COPY_EXPORT_CONFIRM_CELL_THRESHOLD = 1000000;
const COPY_EXPORT_CONFIRM_BYTES = 50 * 1024 * 1024;
const COPY_EXPORT_SAMPLE_ROWS = 32;
const COPY_EXPORT_SAMPLE_COLUMNS = 12;
const SORT_CONFIRM_ROW_THRESHOLD = 250000;
const SEARCH_MATCH_CAP = 1000;
const SEARCH_YIELD_CELL_INTERVAL = 10000;
const SEARCH_SCAN_CELL_LIMIT = 2000000;
const SEARCH_SCAN_MS_LIMIT = 1500;
const DEFAULT_PANEL_SETTINGS: KdbPanelSettings = {
  cellWidth: 160,
  rowHeight: 28,
  fontSize: 0,
  density: 'standard',
  showRowIndex: true,
  includeHeaders: true,
  includeRowIndex: true,
  hideLargeResultWarnings: false,
  hideLargeSortWarnings: false,
  elapsedTimeDisplay: 'auto',
};
const DEFAULT_DENSITY_SIZE_SETTINGS: { [density in KdbPanelDensity]: Pick<KdbPanelSettings, 'cellWidth' | 'rowHeight' | 'fontSize'> } = {
  compact: {
    cellWidth: 140,
    rowHeight: 24,
    fontSize: 0,
  },
  standard: {
    cellWidth: 160,
    rowHeight: 28,
    fontSize: 0,
  },
  comfortable: {
    cellWidth: 180,
    rowHeight: 32,
    fontSize: 0,
  },
};

export class KdbResultsPanel {
  private static panels: KdbResultsPanel[] = [];
  private static lastActivePanel: KdbResultsPanel | undefined;
  private static nextPanelNumber = 1;
  private readonly disposables: vscode.Disposable[] = [];
  private panel: vscode.WebviewPanel;
  private disposed = false;
  private ready = false;
  private result: KdbPanelResult | undefined;
  private loading: LoadingState | undefined;
  private version = 0;
  private firstSliceVersion = 0;
  private hiddenColumnNames: string[] = [];
  private columnOrder: string[] | undefined;
  private rowOrder: number[] | undefined;
  private sortState: KdbPanelSortState | undefined;
  private hiddenColumnSchema: string[] | undefined;
  private columnOrderSchema: string[] | undefined;
  private baseVisibleTableCache: { version: number; source: ColumnarPanelResult; table: ColumnarPanelResult } | undefined;
  private visibleTableCache: { version: number; source: ColumnarPanelResult; table: ColumnarPanelResult } | undefined;
  private activeSearchId = 0;
  private hideLargeResultWarningOnce = false;

  public static showLoading(
    context: vscode.ExtensionContext,
    state: LoadingState,
    mode: KdbResultsPanelRunMode = 'replace'
  ): KdbResultsPanel {
    const panel = KdbResultsPanel.ensure(context, mode);
    panel.version += 1;
    panel.firstSliceVersion = 0;
    panel.rowOrder = undefined;
    panel.sortState = undefined;
    panel.hideLargeResultWarningOnce = false;
    panel.baseVisibleTableCache = undefined;
    panel.visibleTableCache = undefined;
    panel.loading = state;
    panel.result = undefined;
    panel.revealExisting();
    panel.post({ type: 'loading', state: { ...state, version: panel.version, settings: panelSettings() } });
    return panel;
  }

  public static showResult(
    context: vscode.ExtensionContext,
    result: KdbPanelResult,
    mode: KdbResultsPanelRunMode = 'replace'
  ): KdbResultsPanel {
    const panel = KdbResultsPanel.ensure(context, mode);
    panel.showResult(result);
    return panel;
  }

  public showResult(result: KdbPanelResult): KdbResultsPanel {
    if (this.disposed) {
      return this;
    }
    this.version += 1;
    this.firstSliceVersion = 0;
    this.rowOrder = undefined;
    this.sortState = undefined;
    this.hideLargeResultWarningOnce = false;
    this.baseVisibleTableCache = undefined;
    this.visibleTableCache = undefined;
    this.loading = undefined;
    this.hiddenColumnNames = this.hiddenColumnNamesForNewResult(result.table.columns);
    this.hiddenColumnSchema = result.table.columns.slice();
    this.columnOrder = this.columnOrderForNewResult(result.table.columns);
    this.columnOrderSchema = result.table.columns.slice();
    this.result = result;
    this.revealExisting();
    this.postResultMetadata();
    return this;
  }

  private static ensure(context: vscode.ExtensionContext, mode: KdbResultsPanelRunMode): KdbResultsPanel {
    if (mode === 'new') {
      return new KdbResultsPanel(context, KdbResultsPanel.newPanelViewColumn());
    }

    if (KdbResultsPanel.panels.length === 0) {
      return new KdbResultsPanel(context);
    }

    return KdbResultsPanel.reusablePanel() || new KdbResultsPanel(context);
  }

  private static newPanelViewColumn(): vscode.ViewColumn {
    const anchor = KdbResultsPanel.reusablePanel();
    return anchor && anchor.panel.viewColumn !== undefined
      ? anchor.panel.viewColumn
      : initialResultViewColumn();
  }

  private static reusablePanel(): KdbResultsPanel | undefined {
    return KdbResultsPanel.panels.find(panel => panel.panel.active) ||
      (KdbResultsPanel.lastActivePanel && KdbResultsPanel.panels.indexOf(KdbResultsPanel.lastActivePanel) !== -1
        ? KdbResultsPanel.lastActivePanel
        : undefined) ||
      KdbResultsPanel.panels.find(panel => panel.panel.visible) ||
      KdbResultsPanel.panels[0];
  }

  public static copySelectionFromActivePanel(): void {
    const panel = KdbResultsPanel.reusablePanel();
    if (panel) {
      panel.post({ type: 'copySelection' });
    }
  }

  private constructor(_context: vscode.ExtensionContext, viewColumn: vscode.ViewColumn = initialResultViewColumn()) {
    const panelNumber = KdbResultsPanel.nextPanelNumber++;
    this.panel = vscode.window.createWebviewPanel(
      'kdbSqltoolsResults',
      panelTitle(panelNumber),
      { viewColumn, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );
    KdbResultsPanel.panels.push(this);
    KdbResultsPanel.lastActivePanel = this;
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.onDidDispose(() => this.disposePanel(), undefined, this.disposables);
    this.panel.onDidChangeViewState(event => {
      if (event.webviewPanel.active) {
        KdbResultsPanel.lastActivePanel = this;
      }
    }, undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage(message => this.onMessage(message), undefined, this.disposables);
  }

  private disposePanel(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.ready = false;
    KdbResultsPanel.panels = KdbResultsPanel.panels.filter(panel => panel !== this);
    if (KdbResultsPanel.lastActivePanel === this) {
      KdbResultsPanel.lastActivePanel = KdbResultsPanel.panels[0];
    }
    this.result = undefined;
    this.loading = undefined;
    this.rowOrder = undefined;
    this.sortState = undefined;
    this.hiddenColumnNames = [];
    this.hiddenColumnSchema = undefined;
    this.columnOrder = undefined;
    this.columnOrderSchema = undefined;
    this.baseVisibleTableCache = undefined;
    this.visibleTableCache = undefined;
    this.activeSearchId += 1;
    this.disposables.splice(0).forEach(disposable => disposable.dispose());
  }

  private revealExisting(): void {
    this.panel.reveal(this.panel.viewColumn, true);
    KdbResultsPanel.lastActivePanel = this;
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

    if (message.type === 'tableContextMenu') {
      KdbResultsPanel.lastActivePanel = this;
      return;
    }

    if (message.type === 'requestSlice') {
      this.postSlice(message);
      return;
    }

    if (message.type === 'searchRows') {
      await this.searchRows(message);
      return;
    }

    if (message.type === 'updateSetting') {
      await this.updateSetting(message);
      return;
    }

    if (message.type === 'hideLargeResultWarningOnce') {
      if (Number(message.version) === this.version) {
        this.hideLargeResultWarningOnce = true;
      }
      return;
    }

    if (
      message.type === 'hideColumn' ||
      message.type === 'showColumn' ||
      message.type === 'hideAllColumns' ||
      message.type === 'showAllColumns' ||
      message.type === 'resetHiddenColumns'
    ) {
      this.updateColumnVisibility(message);
      return;
    }

    if (message.type === 'sortColumn') {
      await this.sortColumn(message);
      return;
    }

    if (message.type === 'reorderColumn') {
      this.reorderColumn(message);
      return;
    }

    if (message.type === 'copyRange') {
      await this.copyRange(
        message.version,
        message.range,
        textExportFormat(message.format),
        message.includeHeaders === true,
        message.includeRowIndex === true
      );
      return;
    }

    if (message.type === 'exportRange') {
      await this.exportRange(
        message.version,
        message.range,
        exportFormat(message.format),
        message.includeHeaders === true,
        message.includeRowIndex === true
      );
      return;
    }
  }

  private postResultMetadata(): void {
    if (!this.result) {
      return;
    }
    const tracePerf = isPerfTraceEnabled();
    const span = tracePerf ? perfSpan('results-panel.metadata.post', {
        version: this.version,
        rows: this.result.table.rowCount,
        columns: this.visibleColumnNames(this.result).length,
        totalColumns: this.result.table.columns.length,
        ready: this.ready,
      }) : null;
    try {
      this.post({ type: 'resultMeta', result: this.metadataForResult(this.result) });
    } finally {
      if (tracePerf) {
        endPerfSpan(span, { posted: this.ready });
      }
    }
  }

  private metadataForResult(result: KdbPanelResult): KdbPanelMetadata {
    const columns = this.visibleColumnNames(result);
    const hiddenColumnNames = this.activeHiddenColumnNames(result);
    const settings = panelSettings();
    return {
      columns,
      allColumns: result.table.columns.slice(),
      hiddenColumnCount: result.table.columns.length - columns.length,
      hiddenColumnNames,
      rowCount: result.table.rowCount,
      query: result.query,
      connectionName: result.connectionName,
      elapsedMs: result.elapsedMs,
      messages: result.messages,
      error: result.error,
      version: this.version,
      settings,
      sort: this.visibleSortState(result),
      guardrailMessage: settings.hideLargeResultWarnings || this.hideLargeResultWarningOnce
        ? undefined
        : resultSizeGuardrailMessage(result.table.rowCount, result.table.columns.length),
    };
  }

  private baseVisibleTable(): ColumnarPanelResult | null {
    if (!this.result) {
      return null;
    }

    if (
      this.baseVisibleTableCache &&
      this.baseVisibleTableCache.version === this.version &&
      this.baseVisibleTableCache.source === this.result.table
    ) {
      return this.baseVisibleTableCache.table;
    }

    const table = filterColumnarPanelResult(this.result.table, this.visibleColumnNames(this.result));
    this.baseVisibleTableCache = { version: this.version, source: this.result.table, table };
    return table;
  }

  private visibleTable(): ColumnarPanelResult | null {
    if (!this.result) {
      return null;
    }

    const table = this.baseVisibleTable();
    if (!table || !this.rowOrder) {
      return table;
    }

    if (
      this.visibleTableCache &&
      this.visibleTableCache.version === this.version &&
      this.visibleTableCache.source === this.result.table
    ) {
      return this.visibleTableCache.table;
    }

    const orderedTable = applyColumnarRowOrder(table, this.rowOrder);
    this.visibleTableCache = { version: this.version, source: this.result.table, table: orderedTable };
    return orderedTable;
  }

  private visibleSortState(result: KdbPanelResult): KdbPanelSortState | null {
    if (!this.sortState) {
      return null;
    }

    return this.visibleColumnNames(result).indexOf(this.sortState.columnName) === -1
      ? null
      : { ...this.sortState };
  }

  private visibleColumnNames(result: KdbPanelResult): string[] {
    const hidden = columnNameLookup(this.hiddenColumnNames);
    return this.orderedColumnNames(result.table.columns).filter(column => !hidden[column]);
  }

  private orderedColumnNames(columns: string[]): string[] {
    const available = columnNameLookup(columns);
    const ordered: string[] = [];
    if (this.columnOrder) {
      this.columnOrder.forEach(column => {
        if (available[column] && ordered.indexOf(column) === -1) {
          ordered.push(column);
        }
      });
    }
    columns.forEach(column => {
      if (ordered.indexOf(column) === -1) {
        ordered.push(column);
      }
    });
    return ordered;
  }

  private activeHiddenColumnNames(result: KdbPanelResult): string[] {
    const hidden = columnNameLookup(this.hiddenColumnNames);
    const names: string[] = [];
    result.table.columns.forEach(column => {
      if (hidden[column] && names.indexOf(column) === -1) {
        names.push(column);
      }
    });
    return names;
  }

  private postSlice(message: any): void {
    const requestId = Number(message.requestId || 0);
    const tracePerf = isPerfTraceEnabled();
    const requestSpan = tracePerf ? perfSpan('results-panel.requestSlice', {
        version: Number(message.version),
        currentVersion: this.version,
        requestId,
      }) : null;
    if (!this.result || Number(message.version) !== this.version) {
      if (tracePerf) {
        endPerfSpan(requestSpan, { skipped: true });
      }
      return;
    }

    const table = this.visibleTable();
    if (!table) {
      if (tracePerf) {
        endPerfSpan(requestSpan, { skipped: true });
      }
      return;
    }

    const rowRange = messageRange(message.rows, table.rowCount);
    const columnRange = messageRange(message.columns, table.columns.length);
    const firstSlice = this.firstSliceVersion !== this.version;
    const sliceSpan = tracePerf ? perfSpan('results-panel.slice.generate', {
        version: this.version,
        requestId,
        firstSlice,
        rowsRequested: rowRange.end - rowRange.start + 1,
        columnsRequested: columnRange.end - columnRange.start + 1,
        totalRows: table.rowCount,
        totalColumns: table.columns.length,
      }) : null;
    const firstSliceSpan = tracePerf && firstSlice ? perfSpan('results-panel.firstSlice', {
        version: this.version,
        requestId,
        rowsRequested: rowRange.end - rowRange.start + 1,
        columnsRequested: columnRange.end - columnRange.start + 1,
        totalRows: table.rowCount,
        totalColumns: table.columns.length,
      }) : null;
    try {
      const slice = table.cellWindow(rowRange, columnRange);
      const sliceDetails = tracePerf ? {
        rows: slice.endRow >= slice.startRow ? slice.endRow - slice.startRow + 1 : 0,
        columns: slice.endColumn >= slice.startColumn ? slice.endColumn - slice.startColumn + 1 : 0,
        cells: slice.cells.reduce((count, row) => count + row.length, 0),
      } : undefined;
      if (tracePerf) {
        endPerfSpan(sliceSpan, sliceDetails);
        endPerfSpan(firstSliceSpan, sliceDetails);
      }
      if (firstSlice) {
        this.firstSliceVersion = this.version;
      }
      this.post({
        type: 'slice',
        version: this.version,
        requestId,
        slice,
      });
      if (tracePerf) {
        endPerfSpan(requestSpan, { skipped: false, posted: this.ready });
      }
    } catch (error) {
      if (tracePerf) {
        endPerfSpan(sliceSpan, { error: true, errorName: toError(error).name });
        endPerfSpan(firstSliceSpan, { error: true, errorName: toError(error).name });
        endPerfSpan(requestSpan, { skipped: false, error: true, errorName: toError(error).name });
      }
      throw error;
    }
  }

  private async searchRows(message: any): Promise<void> {
    const requestVersion = integerOrNull(message.version);
    const searchId = integerOrNull(message.searchId);
    const query = typeof message.query === 'string' ? message.query : '';
    if (requestVersion === null || searchId === null || !this.result || requestVersion !== this.version) {
      return;
    }

    this.activeSearchId = searchId;
    const table = this.visibleTable();
    if (!table) {
      return;
    }

    const tracePerf = isPerfTraceEnabled();
    const span = tracePerf ? perfSpan('results-panel.searchRows', {
        version: requestVersion,
        searchId,
        rows: table.rowCount,
        columns: table.columns.length,
        queryChars: query.length,
        matchCap: SEARCH_MATCH_CAP,
      }) : null;
    const matchedRows: number[] = [];
    let totalScanned = 0;
    let scannedCells = 0;
    let capped = false;
    let partial = false;
    let cancelled = false;

    try {
      const needle = query.toLowerCase();
      if (needle.length > 0 && table.rowCount > 0 && table.columns.length > 0) {
        const startedMs = Date.now();
        for (let rowIndex = 0; rowIndex < table.rowCount; rowIndex++) {
          let rowMatched = false;
          for (let columnIndex = 0; columnIndex < table.columns.length; columnIndex++) {
            scannedCells += 1;
            if (table.cellText(rowIndex, columnIndex).toLowerCase().indexOf(needle) !== -1) {
              rowMatched = true;
              break;
            }

            if (scannedCells % SEARCH_YIELD_CELL_INTERVAL === 0) {
              if (Date.now() - startedMs >= SEARCH_SCAN_MS_LIMIT || scannedCells >= SEARCH_SCAN_CELL_LIMIT) {
                partial = true;
                break;
              }
              await yieldToEventLoop();
              if (this.activeSearchId !== searchId || this.version !== requestVersion) {
                cancelled = true;
                return;
              }
            }
          }

          totalScanned += 1;
          if (rowMatched) {
            matchedRows.push(rowIndex);
            if (matchedRows.length >= SEARCH_MATCH_CAP) {
              capped = true;
              partial = rowIndex < table.rowCount - 1;
              break;
            }
          }
          if (partial) {
            break;
          }
        }
      }

      if (this.activeSearchId !== searchId || this.version !== requestVersion) {
        cancelled = true;
        return;
      }

      this.post({
        type: 'searchResults',
        version: requestVersion,
        searchId,
        query,
        matchedRows,
        totalScanned,
        scannedCells,
        capped,
        partial,
        matchCap: SEARCH_MATCH_CAP,
      });
    } finally {
      if (tracePerf) {
        endPerfSpan(span, {
          matches: matchedRows.length,
          totalScanned,
          scannedCells,
          capped,
          partial,
          cancelled,
        });
      }
    }
  }

  private async sortColumn(message: any): Promise<void> {
    const requestVersion = integerOrNull(message.version);
    const columnIndex = integerOrNull(message.columnIndex);
    const columnName = typeof message.columnName === 'string' ? message.columnName : '';
    if (requestVersion === null || columnIndex === null || !this.result || requestVersion !== this.version) {
      return;
    }

    const table = this.baseVisibleTable();
    if (!table || columnIndex < 0 || columnIndex >= table.columns.length || table.columns[columnIndex] !== columnName) {
      return;
    }

    const nextSort = nextSortState(this.sortState, columnName);
    if (!nextSort) {
      this.rowOrder = undefined;
      this.sortState = undefined;
      this.refreshResultView();
      return;
    }

    if (table.rowCount >= SORT_CONFIRM_ROW_THRESHOLD && !panelSettings().hideLargeSortWarnings) {
      const choice = await vscode.window.showWarningMessage(
        `Sort ${formatCount(table.rowCount)} rows by ${columnName}? This may take a moment.`,
        'Sort',
        "Sort and Don't Warn Again",
        'Cancel'
      );
      if (!this.isCurrentVersion(requestVersion)) {
        return;
      }
      if (choice === "Sort and Don't Warn Again") {
        await vscode.workspace.getConfiguration('kdb-sqltools.results').update(
          'hideLargeSortWarnings',
          true,
          vscode.ConfigurationTarget.Global
        );
        this.post({ type: 'settings', settings: panelSettings() });
        if (!this.isCurrentVersion(requestVersion)) {
          return;
        }
      }
      if (choice !== 'Sort' && choice !== "Sort and Don't Warn Again") {
        this.post({ type: 'sortSkipped', version: requestVersion });
        return;
      }
    }

    const tracePerf = isPerfTraceEnabled();
    const span = tracePerf ? perfSpan('results-panel.sort', {
        version: requestVersion,
        rows: table.rowCount,
        columns: table.columns.length,
        columnName,
        direction: nextSort.direction,
      }) : null;
    let sortedRowOrder: number[] | undefined;
    let cancelled = false;
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: `Sorting ${formatCount(table.rowCount)} rows`,
        cancellable: false,
      }, async () => {
        await yieldToEventLoop();
        sortedRowOrder = sortedColumnarRowOrder(table, columnIndex, nextSort.direction);
      });

      if (!this.result || this.version !== requestVersion || !sortedRowOrder) {
        cancelled = true;
        return;
      }

      this.rowOrder = sortedRowOrder;
      this.sortState = nextSort;
      this.refreshResultView();
    } finally {
      if (tracePerf) {
        endPerfSpan(span, {
          sorted: !!sortedRowOrder && !cancelled,
          cancelled,
        });
      }
    }
  }

  private async copyRange(
    version: any,
    range: any,
    format: TextExportFormat,
    includeHeaders: boolean,
    includeRowIndex: boolean
  ): Promise<void> {
    const requestVersion = integerOrNull(version);
    if (requestVersion === null || requestVersion !== this.version) {
      return;
    }

    const table = this.visibleTable();
    if (!table) {
      return;
    }

    const clamped = this.actionRange(range, table);
    if (!clamped) {
      return;
    }

    const estimate = estimateCopyExport(table, clamped, format, includeHeaders, includeRowIndex);
    if (!(await this.confirmLargeCopyExport('copy', format, estimate))) {
      if (this.isCurrentVersion(requestVersion)) {
        this.post({ type: 'copySkipped', version: requestVersion, format });
      }
      return;
    }
    if (!this.isCurrentVersion(requestVersion)) {
      return;
    }

    const text = table.toText(format, clamped, {
      includeHeaders,
      includeRowIndex,
    });
    if (Buffer.byteLength(text, 'utf8') > COPY_WARNING_BYTES) {
      const choice = await vscode.window.showWarningMessage(
        `Copy output is ${formatBytes(Buffer.byteLength(text, 'utf8'))}. Export instead?`,
        'Export',
        'Copy Anyway'
      );
      if (!this.isCurrentVersion(requestVersion)) {
        return;
      }
      if (choice === 'Export') {
        await this.exportRange(requestVersion, clamped, format, includeHeaders, includeRowIndex);
        return;
      }
      if (choice !== 'Copy Anyway') {
        this.post({ type: 'copySkipped', version: requestVersion, format });
        return;
      }
    }

    await vscode.env.clipboard.writeText(text);
    if (!this.isCurrentVersion(requestVersion)) {
      return;
    }
    const rows = clamped.endRow - clamped.startRow + 1;
    const columns = clamped.endColumn - clamped.startColumn + 1;
    this.post({ type: 'copied', version: requestVersion, rows, columns, format, includeHeaders, includeRowIndex });
  }

  private async exportRange(
    version: any,
    range: any,
    format: ExportFormat,
    includeHeaders: boolean,
    includeRowIndex: boolean
  ): Promise<void> {
    const requestVersion = integerOrNull(version);
    if (requestVersion === null || requestVersion !== this.version) {
      return;
    }

    const table = this.visibleTable();
    if (!table) {
      return;
    }

    const clamped = this.actionRange(range, table);
    if (!clamped) {
      return;
    }

    if (format === 'xlsx') {
      const limitError = validateXlsxSheetLimits(clamped, { includeHeaders, includeRowIndex });
      if (limitError) {
        await vscode.window.showErrorMessage(limitError);
        if (this.isCurrentVersion(requestVersion)) {
          this.post({ type: 'exportSkipped', version: requestVersion, format });
        }
        return;
      }
    }

    const estimate = estimateCopyExport(table, clamped, format, includeHeaders, includeRowIndex);
    if (!(await this.confirmLargeCopyExport('export', format, estimate))) {
      if (this.isCurrentVersion(requestVersion)) {
        this.post({ type: 'exportSkipped', version: requestVersion, format });
      }
      return;
    }
    if (!this.isCurrentVersion(requestVersion)) {
      return;
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: defaultExportUri(format),
      filters: saveFilters(format),
      saveLabel: 'Export',
    });
    if (!this.isCurrentVersion(requestVersion)) {
      return;
    }
    if (!uri) {
      this.post({ type: 'exportSkipped', version: requestVersion, format });
      return;
    }

    const content = format === 'xlsx'
      ? await columnarToXlsx(table, clamped, includeHeaders, includeRowIndex)
      : Buffer.from(table.toText(format, clamped, {
        includeHeaders,
        includeRowIndex,
      }), 'utf8');
    if (!this.isCurrentVersion(requestVersion)) {
      return;
    }
    await vscode.workspace.fs.writeFile(uri, content);
    if (!this.isCurrentVersion(requestVersion)) {
      return;
    }
    const rows = clamped.endRow - clamped.startRow + 1;
    const columns = clamped.endColumn - clamped.startColumn + 1;
    this.post({ type: 'exported', version: requestVersion, rows, columns, format, includeHeaders, includeRowIndex });
  }

  private async confirmLargeCopyExport(
    action: 'copy' | 'export',
    format: ExportFormat,
    estimate: CopyExportEstimate
  ): Promise<boolean> {
    const message = largeCopyExportConfirmationMessage(action, format, estimate);
    if (!message) {
      return true;
    }

    const choice = await vscode.window.showWarningMessage(message, 'Continue', 'Cancel');
    return choice === 'Continue';
  }

  private actionRange(range: any, table: ColumnarPanelResult): CellRange | null {
    const requested = messageCellRange(range) || allCellsRange(table.rowCount, table.columns.length);
    return clampCellRange(requested, table.rowCount, table.columns.length);
  }

  private reorderColumn(message: any): void {
    const requestVersion = integerOrNull(message.version);
    if (requestVersion === null || !this.result || requestVersion !== this.version) {
      return;
    }

    const sourceColumnName = typeof message.sourceColumnName === 'string' ? message.sourceColumnName : '';
    const targetColumnName = typeof message.targetColumnName === 'string' ? message.targetColumnName : '';
    if (!sourceColumnName || !targetColumnName || sourceColumnName === targetColumnName) {
      return;
    }

    const visibleColumns = this.visibleColumnNames(this.result);
    if (visibleColumns.indexOf(sourceColumnName) === -1 || visibleColumns.indexOf(targetColumnName) === -1) {
      return;
    }

    const nextVisibleColumns = moveColumnName(visibleColumns, sourceColumnName, targetColumnName);
    if (sameColumnNames(visibleColumns, nextVisibleColumns)) {
      return;
    }

    this.columnOrder = mergeVisibleColumnOrder(
      this.orderedColumnNames(this.result.table.columns),
      nextVisibleColumns,
      this.hiddenColumnNames
    );
    this.columnOrderSchema = this.result.table.columns.slice();
    this.refreshResultView();
  }

  private updateColumnVisibility(message: any): void {
    if (!this.result) {
      return;
    }

    if (message.type === 'resetHiddenColumns' || message.type === 'showAllColumns') {
      if (this.hiddenColumnNames.length > 0) {
        this.hiddenColumnNames = [];
        this.refreshResultView();
      }
      return;
    }

    if (message.type === 'hideAllColumns') {
      this.hiddenColumnSchema = this.result.table.columns.slice();
      this.hiddenColumnNames = this.result.table.columns.slice();
      this.rowOrder = undefined;
      this.sortState = undefined;
      this.refreshResultView();
      return;
    }

    const columnName = typeof message.columnName === 'string' ? message.columnName : '';
    if (!columnName || this.result.table.columns.indexOf(columnName) === -1) {
      return;
    }

    if (message.type === 'hideColumn') {
      if (this.hiddenColumnNames.indexOf(columnName) === -1) {
        this.hiddenColumnSchema = this.result.table.columns.slice();
        this.hiddenColumnNames = this.hiddenColumnNames.concat(columnName);
        if (this.sortState && this.sortState.columnName === columnName) {
          this.rowOrder = undefined;
          this.sortState = undefined;
        }
        this.refreshResultView();
      }
      return;
    }

    if (message.type === 'showColumn') {
      if (this.hiddenColumnNames.indexOf(columnName) !== -1) {
        this.hiddenColumnSchema = this.result.table.columns.slice();
        this.hiddenColumnNames = this.hiddenColumnNames.filter(name => name !== columnName);
        this.refreshResultView();
      }
    }
  }

  private hiddenColumnNamesForNewResult(columns: string[]): string[] {
    if (!sameColumnNames(this.hiddenColumnSchema, columns)) {
      return [];
    }

    const available = columnNameLookup(columns);
    const names: string[] = [];
    this.hiddenColumnNames.forEach(column => {
      if (available[column] && names.indexOf(column) === -1) {
        names.push(column);
      }
    });
    return names;
  }

  private columnOrderForNewResult(columns: string[]): string[] | undefined {
    if (!sameColumnNames(this.columnOrderSchema, columns) || !this.columnOrder) {
      return undefined;
    }

    const available = columnNameLookup(columns);
    const names: string[] = [];
    this.columnOrder.forEach(column => {
      if (available[column] && names.indexOf(column) === -1) {
        names.push(column);
      }
    });
    columns.forEach(column => {
      if (names.indexOf(column) === -1) {
        names.push(column);
      }
    });
    return names;
  }

  private refreshResultView(): void {
    this.version += 1;
    this.firstSliceVersion = 0;
    this.baseVisibleTableCache = undefined;
    this.visibleTableCache = undefined;
    this.postResultMetadata();
  }

  private async updateSetting(message: any): Promise<void> {
    const normalized = normalizePanelSettingUpdate(message && message.key, message && message.value);
    if (!normalized) {
      return;
    }

    const config = vscode.workspace.getConfiguration('kdb-sqltools.results');
    const settingKey = panelSettingConfigKey(
      normalized.key,
      panelDensity(message && message.density ? message.density : config.get<string>('density'))
    );
    await config.update(settingKey, normalized.value, vscode.ConfigurationTarget.Global);
    this.post({ type: 'settings', settings: panelSettings() });
  }

  private isCurrentVersion(version: number): boolean {
    return !!this.result && this.version === version;
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
      overflow: visible;
    }
    button, select, input[type="number"], input[type="search"] {
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
    select, input[type="number"] {
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 2px;
    }
    input[type="number"] {
      padding: 0 4px;
      box-sizing: border-box;
    }
    input[type="search"] {
      min-width: 110px;
      width: 150px;
      padding: 0 6px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-dropdown-border));
      border-radius: 2px;
      box-sizing: border-box;
    }
    .checkbox {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--vscode-descriptionForeground);
    }
    .settings {
      position: relative;
      flex: 0 0 auto;
      color: var(--vscode-editor-foreground);
    }
    .settings summary {
      height: 26px;
      line-height: 26px;
      padding: 0 8px;
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 2px;
      background: var(--vscode-dropdown-background);
      cursor: pointer;
      list-style-position: inside;
      box-sizing: border-box;
    }
    .settings-panel {
      position: absolute;
      top: 30px;
      right: 0;
      z-index: 20;
      display: grid;
      gap: 8px;
      width: 280px;
      max-height: calc(100vh - 60px);
      overflow: auto;
      padding: 10px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      box-shadow: 0 4px 12px var(--vscode-widget-shadow);
      box-sizing: border-box;
    }
    .settings-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 94px;
      gap: 8px;
      align-items: center;
    }
    .settings-row select,
    .settings-row input[type="number"] {
      width: 100%;
      min-width: 0;
    }
    .settings-section {
      display: grid;
      gap: 6px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .settings-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      color: var(--vscode-descriptionForeground);
    }
    .settings-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    .column-list {
      display: grid;
      gap: 2px;
      max-height: 180px;
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
      padding: 4px;
      box-sizing: border-box;
    }
    .column-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 22px;
      min-width: 0;
    }
    .column-row span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .reset-columns {
      width: 100%;
    }
    .search {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      flex: 0 1 auto;
    }
    .search button {
      padding: 0 6px;
    }
    .search-status {
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      max-width: 160px;
    }
    .summary, .selection, .status {
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .status {
      color: var(--vscode-descriptionForeground);
    }
    .selection {
      margin-left: auto;
      color: var(--vscode-descriptionForeground);
    }
    .large-warning {
      position: relative;
      flex: 0 0 auto;
      color: var(--vscode-descriptionForeground);
    }
    .large-warning summary {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 24px;
      padding: 0 6px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 2px;
      background: var(--vscode-editor-background);
      cursor: pointer;
      list-style: none;
      box-sizing: border-box;
    }
    .large-warning summary::-webkit-details-marker {
      display: none;
    }
    .large-warning-panel {
      width: 340px;
      max-width: calc(100vw - 20px);
      margin-top: 6px;
      padding: 10px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      white-space: normal;
      box-sizing: border-box;
    }
    .large-warning-text {
      line-height: 1.35;
    }
    .large-warning-actions {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .large-warning-actions button {
      height: 24px;
      padding: 0 6px;
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
      display: grid;
      gap: 8px;
      padding: 10px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
      max-height: 80px;
      overflow: auto;
      box-sizing: border-box;
    }
    .message.error {
      color: var(--vscode-errorForeground);
    }
    .message-text {
      white-space: pre-wrap;
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
      transition: background-color 80ms ease, box-shadow 80ms ease, opacity 80ms ease, transform 80ms ease;
    }
    .header.drag-active,
    .header.drag-active .cell {
      cursor: grabbing;
    }
    .resize-handle {
      position: absolute;
      top: 0;
      right: 0;
      width: 8px;
      height: 100%;
      cursor: col-resize;
      background: transparent;
    }
    .resize-handle:hover {
      background: var(--vscode-focusBorder);
    }
    .header .cell.drag-source {
      opacity: 0.68;
      transform: translateY(-2px);
      z-index: 6;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25), inset 0 0 0 1px var(--vscode-focusBorder);
    }
    .header .cell.drag-target {
      background: var(--vscode-list-hoverBackground, var(--vscode-editorGroupHeader-tabsBackground));
      box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
    }
    .header .cell.drag-target-before::before,
    .header .cell.drag-target-after::after {
      content: "";
      position: absolute;
      top: 3px;
      bottom: 3px;
      width: 3px;
      border-radius: 2px;
      background: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-editor-background);
    }
    .header .cell.drag-target-before::before {
      left: 0;
    }
    .header .cell.drag-target-after::after {
      right: 0;
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
    .search-match:not(.selected) {
      background: var(--vscode-editor-findMatchHighlightBackground);
    }
    .search-active {
      box-shadow: inset 0 0 0 1px var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder));
    }
    .empty {
      position: absolute;
      padding: 16px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <select id="actionFormat" aria-label="Copy/export format" disabled>
      <option value="csv">CSV</option>
      <option value="xlsx">XLSX</option>
      <option value="tsv">TSV</option>
      <option value="json">JSON</option>
      <option value="ndjson">NDJSON</option>
      <option value="html">HTML</option>
      <option value="markdown">Markdown</option>
    </select>
    <button id="copy" disabled>Copy</button>
    <button id="export" disabled>Export</button>
    <label class="checkbox"><input id="includeRowIndex" type="checkbox" checked>Row #</label>
    <label class="checkbox"><input id="includeHeaders" type="checkbox" checked>Headers</label>
    <label class="checkbox"><input id="autoFit" type="checkbox" disabled>Auto-fit</label>
    <select id="interactionMode" aria-label="Header mode">
      <option value="drag">Drag</option>
      <option value="select">Select</option>
      <option value="sort">Sort</option>
    </select>
    <span id="sortStatus" class="status">Sort: none</span>
    <span class="search">
      <input id="searchInput" type="search" placeholder="Search" aria-label="Search visible cells" disabled>
      <button id="searchPrev" disabled>Prev</button>
      <button id="searchNext" disabled>Next</button>
      <span id="searchStatus" class="search-status"></span>
    </span>
    <details id="settingsMenu" class="settings">
      <summary>Settings</summary>
      <div class="settings-panel">
        <label class="checkbox"><input id="settingsShowRowIndex" type="checkbox">Show row #</label>
        <label class="checkbox"><input id="settingsIncludeHeaders" type="checkbox">Include headers</label>
        <label class="checkbox"><input id="settingsIncludeRowIndex" type="checkbox">Include row #</label>
        <label class="checkbox"><input id="settingsHideLargeResultWarnings" type="checkbox">Hide large-result warnings</label>
        <label class="checkbox"><input id="settingsHideLargeSortWarnings" type="checkbox">Hide large-sort warnings</label>
        <label class="settings-row"><span>Elapsed time</span><select id="settingsElapsedTimeDisplay">
          <option value="auto">Auto</option>
          <option value="milliseconds">Milliseconds</option>
        </select></label>
        <label class="settings-row"><span>Density</span><select id="settingsDensity">
          <option value="compact">Compact</option>
          <option value="standard">Standard</option>
          <option value="comfortable">Comfortable</option>
        </select></label>
        <label class="settings-row"><span>Cell width</span><input id="settingsCellWidth" type="number" min="80" max="600" step="1"></label>
        <label class="settings-row"><span>Row height</span><input id="settingsRowHeight" type="number" min="20" max="80" step="1"></label>
        <label class="settings-row"><span>Font size</span><input id="settingsFontSize" type="number" min="0" max="32" step="1"></label>
        <div class="settings-section">
          <div class="settings-heading"><span>Columns</span><span id="hiddenColumns">All visible</span></div>
          <div class="settings-actions">
            <button id="selectAllColumns" type="button">Select all</button>
            <button id="deselectAllColumns" type="button">Deselect all</button>
          </div>
          <div id="columnList" class="column-list" role="list"></div>
          <button id="resetColumns" class="reset-columns" disabled>Reset hidden columns</button>
          <button id="resetColumnWidths" class="reset-columns" disabled>Reset column widths</button>
        </div>
      </div>
    </details>
    <span id="spinner" class="spinner" hidden></span>
    <span id="summary" class="summary"></span>
    <details id="largeResultWarning" class="large-warning" hidden>
      <summary id="largeResultSummary" title="Large result warning">ⓘ Large result</summary>
      <div class="large-warning-panel">
        <div id="largeResultWarningText" class="large-warning-text"></div>
        <div class="large-warning-actions">
          <button id="hideLargeOnce" type="button">Hide once</button>
          <button id="hideLargeForever" type="button">Hide forever</button>
        </div>
      </div>
    </details>
    <span id="status" class="status"></span>
    <span id="selection" class="selection"></span>
  </div>
  <div id="message" class="message" hidden></div>
  <div id="viewport" tabindex="0" data-vscode-context='{"webviewSection":"kdbResultsTable","preventDefaultContextMenuItems":true}'>
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
      const MAX_SCROLL_PIXELS = 8000000;
      const SCROLL_END_EPSILON = 1;
      const MIN_COLUMN_WIDTH = 80;
      const MAX_COLUMN_WIDTH = 2000;
      const AUTO_COLUMN_WIDTH_CAP = 1200;
      const DEFAULT_SETTINGS = {
        cellWidth: 160,
        rowHeight: 28,
        fontSize: 0,
        density: 'standard',
        showRowIndex: true,
        includeHeaders: true,
        includeRowIndex: true,
        hideLargeResultWarnings: false,
        hideLargeSortWarnings: false,
        elapsedTimeDisplay: 'auto'
      };
      const viewport = document.getElementById('viewport');
      const canvas = document.getElementById('canvas');
      const header = document.getElementById('header');
      const rowsLayer = document.getElementById('rows');
      const actionFormat = document.getElementById('actionFormat');
      const copyButton = document.getElementById('copy');
      const exportButton = document.getElementById('export');
      const includeRowIndex = document.getElementById('includeRowIndex');
      const includeHeaders = document.getElementById('includeHeaders');
      const autoFit = document.getElementById('autoFit');
      const interactionMode = document.getElementById('interactionMode');
      const sortStatus = document.getElementById('sortStatus');
      const searchInput = document.getElementById('searchInput');
      const searchPrev = document.getElementById('searchPrev');
      const searchNext = document.getElementById('searchNext');
      const searchStatus = document.getElementById('searchStatus');
      const settingsShowRowIndex = document.getElementById('settingsShowRowIndex');
      const settingsIncludeHeaders = document.getElementById('settingsIncludeHeaders');
      const settingsIncludeRowIndex = document.getElementById('settingsIncludeRowIndex');
      const settingsHideLargeResultWarnings = document.getElementById('settingsHideLargeResultWarnings');
      const settingsHideLargeSortWarnings = document.getElementById('settingsHideLargeSortWarnings');
      const settingsElapsedTimeDisplay = document.getElementById('settingsElapsedTimeDisplay');
      const settingsDensity = document.getElementById('settingsDensity');
      const settingsCellWidth = document.getElementById('settingsCellWidth');
      const settingsRowHeight = document.getElementById('settingsRowHeight');
      const settingsFontSize = document.getElementById('settingsFontSize');
      const hiddenColumns = document.getElementById('hiddenColumns');
      const columnList = document.getElementById('columnList');
      const selectAllColumns = document.getElementById('selectAllColumns');
      const deselectAllColumns = document.getElementById('deselectAllColumns');
      const resetColumns = document.getElementById('resetColumns');
      const resetColumnWidths = document.getElementById('resetColumnWidths');
      const spinner = document.getElementById('spinner');
      const summary = document.getElementById('summary');
      const largeResultWarning = document.getElementById('largeResultWarning');
      const largeResultSummary = document.getElementById('largeResultSummary');
      const largeResultWarningText = document.getElementById('largeResultWarningText');
      const hideLargeOnce = document.getElementById('hideLargeOnce');
      const hideLargeForever = document.getElementById('hideLargeForever');
      const status = document.getElementById('status');
      const selectionLabel = document.getElementById('selection');
      const message = document.getElementById('message');
      const empty = document.getElementById('empty');
      let data = emptyData();
      let slice = emptySlice();
      let lastRenderedColumns = emptyColumnRange();
      let dragging = false;
      let dragMode = '';
      let selection = null;
      let renderQueued = false;
      let latestRequestId = 0;
      let pendingRequestKey = '';
      let searchTimer = 0;
      let search = emptySearch();
      let settings = normalizeSettings(DEFAULT_SETTINGS);
      let layout = layoutFromSettings(settings);
      let columnWidthOverrides = Object.create(null);
      let autoColumnWidths = Object.create(null);
      let columnWidthSchema = [];
      let resizeState = null;
      let autoFitEnabled = false;
      let columnDragState = null;

      window.addEventListener('message', event => {
        const msg = event.data || {};
        if (msg.type === 'loading') {
          setLoading(msg.state || {});
        } else if (msg.type === 'resultMeta') {
          setResultMeta(msg.result || {});
        } else if (msg.type === 'slice') {
          setSlice(msg);
        } else if (msg.type === 'searchResults') {
          setSearchResults(msg);
        } else if (msg.type === 'settings') {
          applySettings(msg.settings);
          updateSummary();
          updateLargeResultWarning();
          updateActionState();
          updateSelectionLabel();
          renderNow();
        } else if (msg.type === 'copied' && isCurrentVersionMessage(msg)) {
          status.textContent = 'Copied ' + msg.rows + 'x' + msg.columns + ' ' + String(msg.format || '').toUpperCase();
        } else if (msg.type === 'exported' && isCurrentVersionMessage(msg)) {
          status.textContent = 'Exported ' + msg.rows + 'x' + msg.columns + ' ' + String(msg.format || '').toUpperCase();
        } else if (msg.type === 'exportSkipped' && isCurrentVersionMessage(msg)) {
          status.textContent = String(msg.format || '').toUpperCase() + ' export skipped';
        } else if (msg.type === 'copySkipped' && isCurrentVersionMessage(msg)) {
          status.textContent = 'Copy skipped';
        } else if (msg.type === 'sortSkipped' && isCurrentVersionMessage(msg)) {
          status.textContent = 'Sort skipped';
        } else if (msg.type === 'columnVisibilitySkipped' && isCurrentVersionMessage(msg)) {
          status.textContent = String(msg.message || 'Column visibility unchanged');
          renderColumnSettings();
        } else if (msg.type === 'copySelection') {
          copySelection();
        }
      });

      actionFormat.addEventListener('change', () => {
        updateActionState();
        if (String(actionFormat.value || '') === 'xlsx') {
          status.textContent = 'XLSX is export-only';
        }
      });
      copyButton.addEventListener('click', copySelection);
      exportButton.addEventListener('click', exportSelection);
      includeHeaders.addEventListener('change', () => updateSetting('includeHeaders', !!includeHeaders.checked));
      includeRowIndex.addEventListener('change', () => updateSetting('includeRowIndex', !!includeRowIndex.checked));
      autoFit.addEventListener('change', () => setAutoFitEnabled(!!autoFit.checked));
      interactionMode.addEventListener('change', () => {
        if (dragMode === 'reorder') {
          dragging = false;
          dragMode = '';
          clearColumnDragState();
          status.textContent = '';
        }
        updateSortStatus();
        renderNow();
      });
      searchInput.addEventListener('input', queueSearchRows);
      searchInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          jumpSearch(event.shiftKey ? -1 : 1);
        } else if (event.key === 'Escape') {
          searchInput.value = '';
          queueSearchRows();
        }
      });
      searchPrev.addEventListener('click', () => jumpSearch(-1));
      searchNext.addEventListener('click', () => jumpSearch(1));
      settingsShowRowIndex.addEventListener('change', () => updateSetting('showRowIndex', !!settingsShowRowIndex.checked));
      settingsIncludeHeaders.addEventListener('change', () => updateSetting('includeHeaders', !!settingsIncludeHeaders.checked));
      settingsIncludeRowIndex.addEventListener('change', () => updateSetting('includeRowIndex', !!settingsIncludeRowIndex.checked));
      settingsHideLargeResultWarnings.addEventListener('change', () => updateSetting('hideLargeResultWarnings', !!settingsHideLargeResultWarnings.checked));
      settingsHideLargeSortWarnings.addEventListener('change', () => updateSetting('hideLargeSortWarnings', !!settingsHideLargeSortWarnings.checked));
      settingsElapsedTimeDisplay.addEventListener('change', () => updateSetting('elapsedTimeDisplay', String(settingsElapsedTimeDisplay.value || 'auto')));
      settingsDensity.addEventListener('change', () => updateDensitySetting(String(settingsDensity.value || 'standard')));
      settingsCellWidth.addEventListener('change', () => updateNumberSetting('cellWidth', settingsCellWidth, 80, 600));
      settingsRowHeight.addEventListener('change', () => updateNumberSetting('rowHeight', settingsRowHeight, 20, 80));
      settingsFontSize.addEventListener('change', () => updateNumberSetting('fontSize', settingsFontSize, 0, 32));
      hideLargeOnce.addEventListener('click', event => {
        event.preventDefault();
        data.guardrailMessage = '';
        vscode.postMessage({ type: 'hideLargeResultWarningOnce', version: data.version });
        updateLargeResultWarning();
      });
      hideLargeForever.addEventListener('click', event => {
        event.preventDefault();
        data.guardrailMessage = '';
        updateSetting('hideLargeResultWarnings', true);
        updateLargeResultWarning();
      });
      selectAllColumns.addEventListener('click', () => {
        status.textContent = 'All data columns visible';
        vscode.postMessage({ type: 'showAllColumns' });
      });
      deselectAllColumns.addEventListener('click', () => {
        status.textContent = 'All data columns hidden';
        vscode.postMessage({ type: 'hideAllColumns' });
      });
      resetColumns.addEventListener('click', () => vscode.postMessage({ type: 'resetHiddenColumns' }));
      resetColumnWidths.addEventListener('click', resetColumnWidthOverrides);
      viewport.addEventListener('scroll', requestRender);
      viewport.addEventListener('contextmenu', () => {
        vscode.postMessage({ type: 'tableContextMenu' });
      });
      window.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && hasTableCells()) {
          event.preventDefault();
          copySelection();
        }
      });
      window.addEventListener('mousemove', event => {
        if (!resizeState) {
          return;
        }
        const width = clampInteger(resizeState.startWidth + event.clientX - resizeState.startX, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
        setColumnWidthOverride(resizeState.column, width);
        event.preventDefault();
      });
      window.addEventListener('mouseup', () => {
        if (resizeState) {
          resizeState = null;
          document.body.style.cursor = '';
        }
        if (dragMode === 'reorder') {
          finishColumnReorder();
        }
        dragging = false;
        clearColumnDragState();
        dragMode = '';
        requestRender();
      });
      window.addEventListener('resize', requestRender);

      function setLoading(state) {
        applySettings(state.settings);
        data = emptyData();
        data.version = toNonNegativeInteger(state.version, data.version + 1);
        data.query = state.query || '';
        data.connectionName = state.connectionName || '';
        data.sort = null;
        data.hasResult = false;
        resetWindowState();
        summary.textContent = 'Running on ' + (state.connectionName || 'kdb');
        status.textContent = '';
        updateSortStatus();
        resetSearch(false);
        selectionLabel.textContent = '';
        spinner.hidden = false;
        setActionsDisabled(true);
        renderColumnSettings();
        showMessage('', false);
        updateLargeResultWarning();
        renderNow();
      }

      function setResultMeta(result) {
        applySettings(result.settings);
        const nextColumns = Array.isArray(result.columns) ? result.columns.map(String) : [];
        if (!sameColumnNames(columnWidthSchema, nextColumns)) {
          columnWidthOverrides = Object.create(null);
          autoColumnWidths = Object.create(null);
          columnWidthSchema = nextColumns.slice();
        }
        data = {
          version: toNonNegativeInteger(result.version, data.version + 1),
          columns: nextColumns,
          allColumns: Array.isArray(result.allColumns) ? result.allColumns.map(String) : [],
          hiddenColumnNames: Array.isArray(result.hiddenColumnNames) ? result.hiddenColumnNames.map(String) : [],
          hiddenColumnCount: toNonNegativeInteger(result.hiddenColumnCount, 0),
          rowCount: toNonNegativeInteger(result.rowCount, 0),
          messages: Array.isArray(result.messages) ? result.messages.map(String) : [],
          guardrailMessage: result.guardrailMessage ? String(result.guardrailMessage) : '',
          query: result.query || '',
          connectionName: result.connectionName || '',
          elapsedMs: toNonNegativeInteger(result.elapsedMs, 0),
          error: !!result.error,
          sort: normalizeSortState(result.sort),
          hasResult: true
        };
        if (data.allColumns.length === 0) {
          data.allColumns = data.columns.slice();
        }
        applySettings(settings);
        resetWindowState();
        updateSummary();
        status.textContent = '';
        updateSortStatus();
        resetSearch(false);
        spinner.hidden = true;
        updateActionState();
        updateSelectionLabel();
        renderColumnSettings();
        showMessage(resultMessageText(data), data.error);
        updateLargeResultWarning();
        renderNow();
        if (String(searchInput.value || '').length > 0) {
          queueSearchRows();
        }
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
        updateAutoColumnWidthsFromSlice();
        renderColumnSettings();
        renderNow();
      }

      function resetWindowState() {
        slice = emptySlice();
        lastRenderedColumns = emptyColumnRange();
        selection = null;
        dragging = false;
        clearColumnDragState();
        dragMode = '';
        latestRequestId = 0;
        pendingRequestKey = '';
      }

      function queueSearchRows() {
        if (searchTimer) {
          clearTimeout(searchTimer);
          searchTimer = 0;
        }

        const query = String(searchInput.value || '');
        search.searchId += 1;
        search.query = query;
        search.matches = [];
        search.matchLookup = Object.create(null);
        search.activeIndex = -1;
        search.totalScanned = 0;
        search.scannedCells = 0;
        search.capped = false;
        search.partial = false;
        search.searching = query.length > 0 && hasTableCells();

        if (query.length === 0 || !hasTableCells()) {
          updateSearchStatus();
          updateSearchControls();
          requestRender();
          sendSearchRows(search.searchId, query);
          return;
        }

        updateSearchStatus();
        updateSearchControls();
        const searchId = search.searchId;
        searchTimer = setTimeout(() => sendSearchRows(searchId, query), 250);
      }

      function sendSearchRows(searchId, query) {
        if (searchId !== search.searchId || query !== search.query) {
          return;
        }
        searchTimer = 0;
        vscode.postMessage({
          type: 'searchRows',
          version: data.version,
          searchId,
          query
        });
      }

      function setSearchResults(msg) {
        const version = toNonNegativeInteger(msg.version, -1);
        const searchId = toInteger(msg.searchId, -1);
        const query = String(msg.query || '');
        if (version !== data.version || searchId !== search.searchId || query !== search.query) {
          return;
        }

        search.matches = normalizeMatchedRows(msg.matchedRows);
        search.matchLookup = rowLookup(search.matches);
        search.activeIndex = search.matches.length > 0 ? 0 : -1;
        search.totalScanned = toNonNegativeInteger(msg.totalScanned, 0);
        search.scannedCells = toNonNegativeInteger(msg.scannedCells, 0);
        search.capped = msg.capped === true;
        search.partial = msg.partial === true;
        search.searching = false;
        updateSearchStatus();
        updateSearchControls();
        if (search.activeIndex >= 0) {
          scrollRowIntoView(search.matches[search.activeIndex]);
        }
        requestRender();
      }

      function isCurrentVersionMessage(msg) {
        return toNonNegativeInteger(msg.version, -1) === data.version;
      }

      function resetSearch(clearInput) {
        if (searchTimer) {
          clearTimeout(searchTimer);
          searchTimer = 0;
        }
        search.searchId += 1;
        search = {
          searchId: search.searchId,
          query: clearInput ? '' : String(searchInput.value || ''),
          matches: [],
          matchLookup: Object.create(null),
          activeIndex: -1,
          totalScanned: 0,
          scannedCells: 0,
          capped: false,
          partial: false,
          searching: false
        };
        if (clearInput) {
          searchInput.value = '';
        }
        updateSearchStatus();
        updateSearchControls();
      }

      function jumpSearch(direction) {
        if (search.matches.length === 0) {
          return;
        }
        if (search.activeIndex < 0) {
          search.activeIndex = direction < 0 ? search.matches.length - 1 : 0;
        } else {
          search.activeIndex = (search.activeIndex + direction + search.matches.length) % search.matches.length;
        }
        scrollRowIntoView(search.matches[search.activeIndex]);
        updateSearchStatus();
        requestRender();
      }

      function scrollRowIntoView(row) {
        if (row < 0 || row >= data.rowCount) {
          return;
        }
        const state = scrollStateForViewport();
        const top = layout.headerHeight + row * layout.rowHeight;
        const bottom = top + layout.rowHeight;
        const visibleTop = state.virtualTop + layout.headerHeight;
        const visibleBottom = state.virtualTop + viewport.clientHeight;
        if (top < visibleTop) {
          viewport.scrollTop = physicalScrollTopForVirtual(state, Math.max(0, top - layout.headerHeight));
        } else if (bottom > visibleBottom) {
          viewport.scrollTop = physicalScrollTopForVirtual(state, Math.max(0, bottom - viewport.clientHeight));
        }
      }

      function updateSearchStatus() {
        if (search.query.length === 0 || !hasTableCells()) {
          searchStatus.textContent = '';
          return;
        }
        if (search.searching) {
          searchStatus.textContent = 'Searching...';
          return;
        }
        if (search.matches.length === 0) {
          searchStatus.textContent = search.partial ? 'No matches (partial)' : 'No matches';
          return;
        }
        searchStatus.textContent = (search.activeIndex + 1) + '/' + search.matches.length +
          (search.capped ? '+' : '') +
          (search.partial ? ' partial' : '');
      }

      function updateSearchControls() {
        const canSearch = hasTableCells();
        const hasMatches = search.matches.length > 0;
        searchInput.disabled = !canSearch;
        searchPrev.disabled = !hasMatches;
        searchNext.disabled = !hasMatches;
      }

      function normalizeMatchedRows(rows) {
        const matches = [];
        if (!Array.isArray(rows)) {
          return matches;
        }
        rows.forEach(value => {
          const row = toInteger(value, -1);
          if (row >= 0 && row < data.rowCount) {
            matches.push(row);
          }
        });
        return matches;
      }

      function rowLookup(rows) {
        const lookup = Object.create(null);
        rows.forEach(row => {
          lookup[row] = true;
        });
        return lookup;
      }

      function isSearchMatchedRow(row) {
        return search.matchLookup[row] === true;
      }

      function isActiveSearchRow(row) {
        return search.activeIndex >= 0 && search.matches[search.activeIndex] === row;
      }

      function setActionsDisabled(disabled) {
        actionFormat.disabled = disabled;
        copyButton.disabled = disabled || String(actionFormat.value || '') === 'xlsx';
        copyButton.title = String(actionFormat.value || '') === 'xlsx' ? 'XLSX is export-only' : '';
        exportButton.disabled = disabled;
        includeRowIndex.disabled = false;
        includeHeaders.disabled = false;
      }

      function updateActionState() {
        setActionsDisabled(!hasTableCells());
      }

      function hasTableCells() {
        return data.rowCount > 0 && data.columns.length > 0;
      }

      function applySettings(value) {
        settings = normalizeSettings(value || {});
        layout = layoutFromSettings(settings);
        syncSettingsControls();
        const root = document.documentElement;
        root.style.setProperty('--cell-width', layout.cellWidth + 'px');
        root.style.setProperty('--row-height', layout.rowHeight + 'px');
        root.style.setProperty('--header-height', layout.headerHeight + 'px');
        root.style.setProperty('--cell-padding-x', layout.cellPaddingX + 'px');
        root.style.setProperty('--panel-font-size', settings.fontSize > 0 ? settings.fontSize + 'px' : 'var(--vscode-font-size)');
      }

      function layoutFromSettings(settings) {
        const rowHeight = clampInteger(settings.rowHeight, 20, 80);
        const showRowIndex = settings.showRowIndex || (data.rowCount > 0 && data.columns.length === 0);
        return {
          cellWidth: settings.cellWidth,
          rowHeight,
          headerHeight: clampInteger(rowHeight + 4, 24, 88),
          cellPaddingX: settings.density === 'compact' ? 5 : settings.density === 'comfortable' ? 11 : 8,
          indexWidth: showRowIndex ? INDEX_WIDTH : 0,
          showRowIndex
        };
      }

      function normalizeSettings(value) {
        return {
          cellWidth: boundedSetting(value.cellWidth, DEFAULT_SETTINGS.cellWidth, 80, 600),
          rowHeight: boundedSetting(value.rowHeight, DEFAULT_SETTINGS.rowHeight, 20, 80),
          fontSize: boundedSetting(value.fontSize, DEFAULT_SETTINGS.fontSize, 0, 32),
          density: normalizeDensity(value.density),
          showRowIndex: typeof value.showRowIndex === 'boolean' ? value.showRowIndex : DEFAULT_SETTINGS.showRowIndex,
          includeHeaders: typeof value.includeHeaders === 'boolean' ? value.includeHeaders : DEFAULT_SETTINGS.includeHeaders,
          includeRowIndex: typeof value.includeRowIndex === 'boolean' ? value.includeRowIndex : DEFAULT_SETTINGS.includeRowIndex,
          hideLargeResultWarnings: typeof value.hideLargeResultWarnings === 'boolean' ? value.hideLargeResultWarnings : DEFAULT_SETTINGS.hideLargeResultWarnings,
          hideLargeSortWarnings: typeof value.hideLargeSortWarnings === 'boolean' ? value.hideLargeSortWarnings : DEFAULT_SETTINGS.hideLargeSortWarnings,
          elapsedTimeDisplay: normalizeElapsedTimeDisplay(value.elapsedTimeDisplay)
        };
      }

      function syncSettingsControls() {
        includeHeaders.checked = settings.includeHeaders;
        includeRowIndex.checked = settings.includeRowIndex;
        settingsShowRowIndex.checked = settings.showRowIndex;
        settingsIncludeHeaders.checked = settings.includeHeaders;
        settingsIncludeRowIndex.checked = settings.includeRowIndex;
        settingsHideLargeResultWarnings.checked = settings.hideLargeResultWarnings;
        settingsHideLargeSortWarnings.checked = settings.hideLargeSortWarnings;
        settingsElapsedTimeDisplay.value = settings.elapsedTimeDisplay;
        settingsDensity.value = settings.density;
        settingsCellWidth.value = String(settings.cellWidth);
        settingsRowHeight.value = String(settings.rowHeight);
        settingsFontSize.value = String(settings.fontSize);
      }

      function updateSetting(key, value) {
        const next = {
          cellWidth: settings.cellWidth,
          rowHeight: settings.rowHeight,
          fontSize: settings.fontSize,
          density: settings.density,
          showRowIndex: settings.showRowIndex,
          includeHeaders: settings.includeHeaders,
          includeRowIndex: settings.includeRowIndex,
          hideLargeResultWarnings: settings.hideLargeResultWarnings,
          hideLargeSortWarnings: settings.hideLargeSortWarnings,
          elapsedTimeDisplay: settings.elapsedTimeDisplay
        };
        next[key] = value;
        applySettings(next);
        if (key === 'cellWidth' || key === 'fontSize' || key === 'density') {
          autoColumnWidths = Object.create(null);
        }
        updateSummary();
        updateLargeResultWarning();
        requestRender();
        vscode.postMessage({ type: 'updateSetting', key, value, density: settings.density });
      }

      function updateDensitySetting(value) {
        updateSetting('density', normalizeDensity(value));
      }

      function updateNumberSetting(key, input, min, max) {
        const value = Number(input.value);
        if (!Number.isFinite(value)) {
          syncSettingsControls();
          return;
        }
        updateSetting(key, clampInteger(value, min, max));
      }

      function renderColumnSettings() {
        const hidden = columnNameLookup(data.hiddenColumnNames);
        hiddenColumns.textContent = data.hiddenColumnCount > 0
          ? data.hiddenColumnCount + ' hidden'
          : 'All visible';
        selectAllColumns.disabled = data.allColumns.length === 0 || data.hiddenColumnCount === 0;
        deselectAllColumns.disabled = data.allColumns.length === 0 || data.hiddenColumnCount >= data.allColumns.length;
        updateAutoFitControlState();
        resetColumns.disabled = data.hiddenColumnCount <= 0;
        resetColumnWidths.disabled = !hasColumnWidthOverrides();
        columnList.textContent = '';
        const fragment = document.createDocumentFragment();
        data.allColumns.forEach(column => {
          const label = document.createElement('label');
          label.className = 'column-row';
          label.setAttribute('role', 'listitem');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = !hidden[column];
          checkbox.addEventListener('change', () => {
            vscode.postMessage({ type: checkbox.checked ? 'showColumn' : 'hideColumn', columnName: column });
          });
          const text = document.createElement('span');
          text.textContent = column;
          text.title = column;
          label.appendChild(checkbox);
          label.appendChild(text);
          fragment.appendChild(label);
        });
        columnList.appendChild(fragment);
      }

      function hasVisibleSliceColumns() {
        return slice.endColumn >= slice.startColumn && data.columns.length > 0;
      }

      function hasVisibleColumnsForAutoFit() {
        return data.columns.length > 0 && lastRenderedColumns.end >= lastRenderedColumns.start;
      }

      function updateAutoFitControlState() {
        autoFit.disabled = data.columns.length === 0;
        autoFit.title = autoFit.disabled ? 'No visible data columns' : 'Fit headers and rendered cells as you scroll';
      }

      function setAutoFitEnabled(enabled) {
        autoFitEnabled = enabled && data.columns.length > 0;
        autoFit.checked = autoFitEnabled;
        autoColumnWidths = Object.create(null);
        status.textContent = autoFitEnabled ? 'Auto-fit enabled' : 'Auto-fit disabled';
        updateAutoColumnWidthsFromSlice();
        updateAutoFitControlState();
        requestRender();
      }

      function updateAutoColumnWidthsFromSlice() {
        if (!autoFitEnabled || !hasVisibleSliceColumns()) {
          return;
        }
        let changed = false;
        for (let column = slice.startColumn; column <= slice.endColumn; column++) {
          if (column < 0 || column >= data.columns.length) {
            continue;
          }
          const key = columnWidthKey(column);
          if (Number.isFinite(columnWidthOverrides[key])) {
            continue;
          }
          let desired = measuredColumnTextWidth(data.columns[column]);
          for (let rowOffset = 0; rowOffset < slice.cells.length; rowOffset++) {
            const row = slice.cells[rowOffset] || [];
            const text = String(row[column - slice.startColumn] || '');
            desired = Math.max(desired, measuredColumnTextWidth(text));
          }
          desired = clampInteger(desired, MIN_COLUMN_WIDTH, AUTO_COLUMN_WIDTH_CAP);
          if (autoColumnWidths[key] !== desired) {
            autoColumnWidths[key] = desired;
            changed = true;
          }
        }
        if (changed) {
          requestRender();
        }
      }

      function measuredColumnTextWidth(text) {
        const fontSize = settings.fontSize > 0 ? settings.fontSize : 13;
        const charWidth = Math.max(7, fontSize * 0.58);
        return Math.ceil(String(text || '').length * charWidth + layout.cellPaddingX * 2 + 18);
      }

      function setColumnWidthOverride(column, width) {
        const key = columnWidthKey(column);
        columnWidthOverrides[key] = clampInteger(width, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
        status.textContent = data.columns[column] + ' width: ' + columnWidthOverrides[key] + 'px';
        resetColumnWidths.disabled = false;
        renderNow();
      }

      function resetColumnWidthOverrides() {
        columnWidthOverrides = Object.create(null);
        autoColumnWidths = Object.create(null);
        status.textContent = autoFitEnabled ? 'Column widths reset; auto-fit active' : 'Column widths reset';
        updateAutoColumnWidthsFromSlice();
        renderColumnSettings();
        requestRender();
      }

      function hasColumnWidthOverrides() {
        return Object.keys(columnWidthOverrides).length > 0;
      }

      function headerMode() {
        const value = String(interactionMode.value || 'drag');
        return value === 'sort' || value === 'select' ? value : 'drag';
      }

      function updateSortStatus() {
        sortStatus.textContent = data.sort
          ? 'Sort: ' + data.sort.columnName + ' ' + data.sort.direction
          : 'Sort: none';
      }

      function normalizeSortState(value) {
        if (!value || typeof value.columnName !== 'string') {
          return null;
        }
        const direction = value.direction === 'desc' ? 'desc' : value.direction === 'asc' ? 'asc' : '';
        return direction ? { columnName: value.columnName, direction } : null;
      }

      function columnNameLookup(columnNames) {
        const lookup = Object.create(null);
        columnNames.forEach(column => {
          lookup[column] = true;
        });
        return lookup;
      }

      function sameColumnNames(left, right) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
          return false;
        }
        for (let index = 0; index < left.length; index++) {
          if (left[index] !== right[index]) {
            return false;
          }
        }
        return true;
      }

      function boundedSetting(value, fallback, min, max) {
        const number = Number(value);
        return Number.isFinite(number) ? clampInteger(number, min, max) : fallback;
      }

      function normalizeDensity(value) {
        return value === 'compact' || value === 'comfortable' ? value : 'standard';
      }

      function normalizeElapsedTimeDisplay(value) {
        return value === 'milliseconds' ? 'milliseconds' : 'auto';
      }

      function updateSummary() {
        if (!data.hasResult) {
          return;
        }
        summary.textContent = formatUiCount(data.rowCount) + ' rows x ' + formatUiCount(data.columns.length) + ' columns' +
          (data.hiddenColumnCount > 0 ? ' (' + formatUiCount(data.hiddenColumnCount) + ' hidden)' : '') +
          (data.connectionName ? ' | ' + data.connectionName : '') +
          ' | ' + formatElapsedMs(data.elapsedMs, settings.elapsedTimeDisplay);
      }

      function formatElapsedMs(milliseconds, display) {
        const value = toNonNegativeInteger(milliseconds, 0);
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

      function formatUiCount(value) {
        return String(Math.max(0, Math.floor(Number(value) || 0))).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
      }

      function showMessage(text, isError) {
        message.hidden = !text;
        message.textContent = '';
        message.className = isError ? 'message error' : 'message';
        if (!text) {
          return;
        }
        const textElement = document.createElement('div');
        textElement.className = 'message-text';
        textElement.textContent = text;
        message.appendChild(textElement);
      }

      function resultMessageText(value) {
        return value.error ? value.messages.slice().join('\\n') : '';
      }

      function updateLargeResultWarning() {
        const text = !data.error && !settings.hideLargeResultWarnings && data.guardrailMessage
          ? data.guardrailMessage
          : '';
        largeResultWarning.hidden = !text;
        largeResultSummary.title = text || 'Large result warning';
        largeResultWarningText.textContent = text;
        if (!text) {
          largeResultWarning.open = false;
        }
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
        const metrics = columnMetrics();
        const verticalState = scrollStateForViewport();
        const horizontalState = horizontalScrollState(viewport.scrollLeft, viewport.clientWidth, metrics.totalWidth);
        canvas.style.width = Math.max(horizontalState.canvasWidth, viewport.clientWidth) + 'px';
        canvas.style.height = verticalState.canvasHeight + 'px';
        if (viewport.scrollTop !== verticalState.physicalTop) {
          viewport.scrollTop = verticalState.physicalTop;
        }
        if (viewport.scrollLeft !== horizontalState.physicalLeft) {
          viewport.scrollLeft = horizontalState.physicalLeft;
        }
        const noVisibleColumns = columnCount === 0 && (rowCount > 0 || data.allColumns.length > 0);
        empty.hidden = rowCount !== 0 && !noVisibleColumns;
        empty.textContent = noVisibleColumns ? 'No visible data columns' : '0 rows';
        empty.style.top = layout.headerHeight + 'px';
        empty.style.left = layout.indexWidth + 'px';

        const rows = visibleRange(verticalState.rowOffset, viewport.clientHeight, layout.rowHeight, rowCount, OVERSCAN_ROWS);
        const columns = visibleColumns(horizontalState, metrics);
        lastRenderedColumns = columns;
        updateAutoFitControlState();
        renderHeader(columns, horizontalState, metrics);
        requestSlice(rows, columns);
        renderRows(rows, columns, verticalState, horizontalState, metrics);
      }

      function scrollStateForViewport() {
        return scrollState(viewport.scrollTop, viewport.clientHeight, data.rowCount, layout);
      }

      function scrollState(physicalScrollTop, viewportHeight, rowCount, currentLayout) {
        const virtualContentHeight = currentLayout.headerHeight + rowCount * currentLayout.rowHeight;
        const physicalContentHeight = Math.min(virtualContentHeight, MAX_SCROLL_PIXELS);
        const canvasHeight = Math.max(physicalContentHeight, viewportHeight);
        const virtualScrollableHeight = Math.max(0, virtualContentHeight - viewportHeight);
        const physicalScrollableHeight = Math.max(0, canvasHeight - viewportHeight);
        const compressed = virtualScrollableHeight > physicalScrollableHeight && physicalScrollableHeight > 0;
        const physicalTop = clampNumber(physicalScrollTop, 0, physicalScrollableHeight);
        const atVerticalScrollEnd = physicalScrollableHeight > 0 && physicalTop >= physicalScrollableHeight - SCROLL_END_EPSILON;
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
          rowOffset: Math.max(0, virtualTop - currentLayout.headerHeight)
        };
      }

      function physicalScrollTopForVirtual(state, virtualTop) {
        const target = clampNumber(virtualTop, 0, state.virtualScrollableHeight);
        if (!state.compressed || state.virtualScrollableHeight <= 0) {
          return target;
        }
        if (target >= state.virtualScrollableHeight - SCROLL_END_EPSILON) {
          return state.physicalScrollableHeight;
        }
        return target * (state.physicalScrollableHeight / state.virtualScrollableHeight);
      }

      function horizontalScrollState(physicalScrollLeft, viewportWidth, totalWidth) {
        const virtualContentWidth = Math.max(0, totalWidth);
        const physicalContentWidth = Math.min(virtualContentWidth, MAX_SCROLL_PIXELS);
        const canvasWidth = Math.max(physicalContentWidth, viewportWidth);
        const virtualScrollableWidth = Math.max(0, virtualContentWidth - viewportWidth);
        const physicalScrollableWidth = Math.max(0, canvasWidth - viewportWidth);
        const compressed = virtualScrollableWidth > physicalScrollableWidth && physicalScrollableWidth > 0;
        const physicalLeft = clampNumber(physicalScrollLeft, 0, physicalScrollableWidth);
        const virtualLeft = compressed
          ? physicalLeft * (virtualScrollableWidth / physicalScrollableWidth)
          : physicalLeft;
        return {
          canvasWidth,
          compressed,
          physicalLeft,
          virtualLeft,
          virtualScrollableWidth,
          physicalScrollableWidth
        };
      }

      function physicalLeftForVirtual(state, virtualLeft) {
        return state.physicalLeft + virtualLeft - state.virtualLeft;
      }

      function visibleColumns(horizontalState, metrics) {
        const offset = Math.max(0, horizontalState.virtualLeft - layout.indexWidth);
        return variableVisibleColumnRange(offset, viewport.clientWidth, metrics, OVERSCAN_COLUMNS);
      }

      function visibleRange(offset, size, itemSize, count, overscan) {
        if (count <= 0 || size <= 0 || itemSize <= 0) {
          return { start: 0, end: -1 };
        }
        const start = Math.max(0, Math.floor(offset / itemSize) - overscan);
        const end = Math.min(count - 1, Math.ceil((offset + size) / itemSize) + overscan);
        return { start, end };
      }

      function variableVisibleColumnRange(offset, size, metrics, overscan) {
        const count = data.columns.length;
        if (count <= 0 || size <= 0) {
          return { start: 0, end: -1 };
        }
        const safeOverscan = Math.max(0, Math.floor(overscan));
        const start = clampInteger(firstVisibleColumn(offset, metrics) - safeOverscan, 0, count - 1);
        const end = clampInteger(lastVisibleColumn(offset + size, metrics) + safeOverscan, 0, count - 1);
        return start <= end ? { start, end } : { start: 0, end: -1 };
      }

      function firstVisibleColumn(offset, metrics) {
        let low = 0;
        let high = data.columns.length - 1;
        let result = high;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (columnLeft(metrics, middle) + columnWidthAt(metrics, middle) > offset) {
            result = middle;
            high = middle - 1;
          } else {
            low = middle + 1;
          }
        }
        return result;
      }

      function lastVisibleColumn(offset, metrics) {
        let low = 0;
        let high = data.columns.length - 1;
        let result = low;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (columnLeft(metrics, middle) < offset) {
            result = middle;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
        return result;
      }

      function columnMetrics() {
        const lefts = [];
        const widths = [];
        let left = 0;
        for (let column = 0; column < data.columns.length; column++) {
          const width = columnWidth(column);
          lefts[column] = left;
          widths[column] = width;
          left += width;
        }
        return {
          lefts,
          widths,
          totalColumnsWidth: left,
          totalWidth: layout.indexWidth + left
        };
      }

      function columnLeft(metrics, column) {
        return metrics.lefts[column] || 0;
      }

      function columnWidthAt(metrics, column) {
        return metrics.widths[column] || settings.cellWidth;
      }

      function columnWidth(column) {
        const key = columnWidthKey(column);
        const override = columnWidthOverrides[key];
        if (Number.isFinite(override)) {
          return clampInteger(override, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
        }
        const autoWidth = autoColumnWidths[key];
        if (autoFitEnabled && Number.isFinite(autoWidth)) {
          return clampInteger(autoWidth, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
        }
        return clampInteger(settings.cellWidth, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
      }

      function columnWidthKey(column) {
        return String(data.columns[column] || column);
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

      function renderHeader(columns, horizontalState, metrics) {
        header.className = columnDragState && dragMode === 'reorder' ? 'header drag-active' : 'header';
        const range = normalizedSelection();
        const cells = layout.showRowIndex ? [createCell({
          text: '#',
          row: -1,
          column: -1,
          left: physicalLeftForVirtual(horizontalState, 0),
          top: 0,
          width: layout.indexWidth,
          headerCell: true,
          selected: isAllSelected(range),
          className: 'cell index'
        })] : [];
        replaceChildren(header, cells.concat(headerCells(columns, range, horizontalState, metrics)));
      }

      function headerCells(columns, range, horizontalState, metrics) {
        const cells = [];
        for (let column = columns.start; column <= columns.end; column++) {
          const width = columnWidthAt(metrics, column);
          cells.push(createCell({
            text: data.columns[column],
            row: -1,
            column,
            left: physicalLeftForVirtual(horizontalState, layout.indexWidth + columnLeft(metrics, column)),
            top: 0,
            width,
            headerCell: true,
            selected: isColumnSelected(column, range),
            className: headerCellClassName(column),
            title: headerCellTitle(column)
          }));
        }
        return cells;
      }

      function headerCellClassName(column) {
        let className = 'cell';
        if (columnDragState && columnDragState.sourceColumn === column) {
          className += ' drag-source';
        } else if (columnDragState && columnDragState.targetColumn === column) {
          className += ' drag-target';
          const position = columnDragDropPosition();
          if (position) {
            className += ' drag-target-' + position;
          }
        }
        return className;
      }

      function headerCellTitle(column) {
        const text = data.columns[column] || '';
        if (!columnDragState || dragMode !== 'reorder') {
          return text;
        }
        if (columnDragState.sourceColumn === column) {
          return 'Dragging ' + text;
        }
        if (columnDragState.targetColumn === column) {
          const position = columnDragDropPosition();
          return position ? 'Drop ' + position + ' ' + text : text;
        }
        return text;
      }

      function renderRows(rows, columns, verticalState, horizontalState, metrics) {
        const range = normalizedSelection();
        const hasCells = sliceCovers(slice, rows, columns);
        const fragment = document.createDocumentFragment();
        for (let row = rows.start; row <= rows.end; row++) {
          const rowElement = document.createElement('div');
          rowElement.className = 'row';
          rowElement.setAttribute('role', 'row');
          rowElement.style.top = renderedRowTop(row, verticalState, layout) + 'px';
          rowElement.style.width = canvas.style.width;
          const searchMatched = isSearchMatchedRow(row);
          const searchActive = isActiveSearchRow(row);
          if (layout.showRowIndex) {
            rowElement.appendChild(createCell({
              text: String(row + 1),
              row,
              column: -1,
              left: physicalLeftForVirtual(horizontalState, 0),
              top: 0,
              width: layout.indexWidth,
              headerCell: false,
              selected: isRowSelected(row, range),
              searchMatch: searchMatched,
              searchActive,
              className: 'cell index'
            }));
          }
          for (let column = columns.start; column <= columns.end; column++) {
            const selected = isSelected(row, column, range);
            const value = hasCells ? cellText(row, column) : '';
            const width = columnWidthAt(metrics, column);
            rowElement.appendChild(createCell({
              text: value,
              row,
              column,
              left: physicalLeftForVirtual(horizontalState, layout.indexWidth + columnLeft(metrics, column)),
              top: 0,
              width,
              headerCell: false,
              selected,
              searchMatch: searchMatched,
              searchActive,
              className: 'cell'
            }));
          }
          fragment.appendChild(rowElement);
        }
        rowsLayer.textContent = '';
        rowsLayer.appendChild(fragment);
      }

      function renderedRowTop(row, state, currentLayout) {
        return state.physicalTop + currentLayout.headerHeight + row * currentLayout.rowHeight - state.virtualTop;
      }

      function createCell(options) {
        const cell = document.createElement('div');
        cell.className = options.className +
          (options.selected ? ' selected' : '') +
          (options.searchMatch ? ' search-match' : '') +
          (options.searchActive ? ' search-active' : '');
        cell.setAttribute('role', options.row >= 0 && options.column < 0 ? 'rowheader' : options.headerCell ? 'columnheader' : 'cell');
        cell.style.left = options.left + 'px';
        cell.style.top = options.top + 'px';
        cell.style.width = options.width + 'px';
        cell.title = String(options.title || options.text || '');
        cell.textContent = String(options.text || '');
        if (options.headerCell && options.column >= 0) {
          const handle = document.createElement('span');
          handle.className = 'resize-handle';
          handle.title = 'Drag to resize column';
          handle.dataset.column = String(options.column);
          handle.addEventListener('mousedown', onColumnResizeMouseDown);
          handle.addEventListener('dblclick', onColumnResizeDoubleClick);
          cell.appendChild(handle);
        }
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

      function onColumnResizeMouseDown(event) {
        if (event.button !== 0 || !hasTableCells()) {
          return;
        }
        const column = Number(event.currentTarget.dataset.column);
        resizeState = {
          column,
          startX: event.clientX,
          startWidth: columnWidth(column)
        };
        dragging = false;
        dragMode = 'resize';
        document.body.style.cursor = 'col-resize';
        viewport.focus();
        event.stopPropagation();
        event.preventDefault();
      }

      function onColumnResizeDoubleClick(event) {
        const column = Number(event.currentTarget.dataset.column);
        const key = columnWidthKey(column);
        delete columnWidthOverrides[key];
        delete autoColumnWidths[key];
        updateAutoColumnWidthsFromSlice();
        status.textContent = data.columns[column] + ' width reset';
        renderColumnSettings();
        requestRender();
        event.stopPropagation();
        event.preventDefault();
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
        if (headerMode() === 'sort') {
          dragging = false;
          clearColumnDragState();
          dragMode = '';
          status.textContent = '';
          vscode.postMessage({
            type: 'sortColumn',
            version: data.version,
            columnIndex: column,
            columnName: data.columns[column]
          });
          event.preventDefault();
          return;
        }
        if (headerMode() === 'drag') {
          dragging = true;
          dragMode = 'reorder';
          beginColumnReorder(column);
          viewport.focus();
          renderNow();
          event.preventDefault();
          return;
        }
        const anchorColumn = event.shiftKey && selection ? selection.anchorColumn : column;
        dragging = true;
        dragMode = 'column';
        selection = { anchorRow: 0, anchorColumn, focusRow: data.rowCount - 1, focusColumn: column };
        viewport.focus();
        updateSelection();
        event.preventDefault();
      }

      function onColumnMouseEnter(event) {
        if (dragging && dragMode === 'reorder' && columnDragState) {
          updateColumnDragTarget(Number(event.currentTarget.dataset.column));
          return;
        }
        if (!dragging || dragMode !== 'column' || !selection) {
          return;
        }
        selection.focusRow = data.rowCount - 1;
        selection.focusColumn = Number(event.currentTarget.dataset.column);
        updateSelection();
      }

      function beginColumnReorder(column) {
        columnDragState = {
          sourceColumn: column,
          targetColumn: column
        };
        document.body.style.cursor = 'grabbing';
        status.textContent = columnDragStatusText();
      }

      function updateColumnDragTarget(column) {
        if (!columnDragState || columnDragState.targetColumn === column) {
          return;
        }
        columnDragState.targetColumn = column;
        status.textContent = columnDragStatusText();
        renderNow();
      }

      function clearColumnDragState() {
        if (!columnDragState) {
          return;
        }
        columnDragState = null;
        document.body.style.cursor = '';
      }

      function columnDragDropPosition() {
        if (!columnDragState) {
          return '';
        }
        const sourceColumn = Number(columnDragState.sourceColumn);
        const targetColumn = Number(columnDragState.targetColumn);
        if (!Number.isFinite(sourceColumn) || !Number.isFinite(targetColumn) || sourceColumn === targetColumn) {
          return '';
        }
        return sourceColumn < targetColumn ? 'after' : 'before';
      }

      function columnDragStatusText() {
        const position = columnDragDropPosition();
        if (!position || !columnDragState) {
          return 'Drag column to reorder';
        }
        const targetColumnName = data.columns[columnDragState.targetColumn] || '';
        return targetColumnName ? 'Drop ' + position + ' ' + targetColumnName : 'Drag column to reorder';
      }

      function finishColumnReorder() {
        if (!columnDragState) {
          return;
        }
        const sourceColumn = Number(columnDragState.sourceColumn);
        const targetColumn = Number(columnDragState.targetColumn);
        const sourceColumnName = data.columns[sourceColumn] || '';
        const targetColumnName = data.columns[targetColumn] || '';
        if (
          sourceColumnName &&
          targetColumnName &&
          sourceColumn !== targetColumn
        ) {
          status.textContent = 'Moving ' + sourceColumnName;
          vscode.postMessage({
            type: 'reorderColumn',
            version: data.version,
            sourceColumn,
            targetColumn,
            sourceColumnName,
            targetColumnName
          });
        } else {
          status.textContent = '';
        }
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
          return 'Selected: all ' + formatUiCount(data.rowCount) + ' rows x ' + formatUiCount(data.columns.length) + ' columns';
        }
        if (fullRows) {
          return selectedColumns === 1
            ? 'Selected: column ' + (data.columns[range.startColumn] || String(range.startColumn + 1))
            : 'Selected: ' + formatUiCount(selectedColumns) + ' columns';
        }
        if (fullColumns) {
          return selectedRows === 1
            ? 'Selected: row ' + formatUiCount(range.startRow + 1)
            : 'Selected: ' + formatUiCount(selectedRows) + ' rows';
        }
        if (selectedRows === 1 && selectedColumns === 1) {
          return 'Selected: 1 cell';
        }
        return 'Selected: ' + formatUiCount(selectedRows) + ' rows x ' + formatUiCount(selectedColumns) + ' columns';
      }

      function copySelection() {
        if (!hasTableCells()) {
          return;
        }
        const format = String(actionFormat.value || 'csv');
        if (format === 'xlsx') {
          status.textContent = 'XLSX is export-only';
          updateActionState();
          return;
        }
        const range = normalizedSelection();
        vscode.postMessage({
          type: 'copyRange',
          version: data.version,
          range,
          format,
          includeHeaders: !!includeHeaders.checked,
          includeRowIndex: !!includeRowIndex.checked
        });
      }

      function exportSelection() {
        if (!hasTableCells()) {
          return;
        }
        const range = normalizedSelection();
        vscode.postMessage({
          type: 'exportRange',
          version: data.version,
          range,
          format: String(actionFormat.value || 'csv'),
          includeHeaders: !!includeHeaders.checked,
          includeRowIndex: !!includeRowIndex.checked
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
          allColumns: [],
          hiddenColumnNames: [],
          hiddenColumnCount: 0,
          rowCount: 0,
          messages: [],
          guardrailMessage: '',
          query: '',
          connectionName: '',
          elapsedMs: 0,
          error: false,
          sort: null,
          hasResult: false
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

      function emptyColumnRange() {
        return {
          start: 0,
          end: -1
        };
      }

      function emptySearch() {
        return {
          searchId: 0,
          query: '',
          matches: [],
          matchLookup: Object.create(null),
          activeIndex: -1,
          totalScanned: 0,
          scannedCells: 0,
          capped: false,
          partial: false,
          searching: false
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

      function clampNumber(value, min, max) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : min;
      }

      vscode.postMessage({ type: 'ready' });
    }());
  </script>
</body>
</html>`;
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, 0));
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
  const density = panelDensity(config.get<string>('density'));
  const size = panelSizeSettings(config, density);
  return {
    cellWidth: size.cellWidth,
    rowHeight: size.rowHeight,
    fontSize: size.fontSize,
    density,
    showRowIndex: booleanSetting(config.get<boolean>('showRowIndex'), DEFAULT_PANEL_SETTINGS.showRowIndex),
    includeHeaders: booleanSetting(config.get<boolean>('includeHeaders'), DEFAULT_PANEL_SETTINGS.includeHeaders),
    includeRowIndex: booleanSetting(config.get<boolean>('includeRowIndex'), DEFAULT_PANEL_SETTINGS.includeRowIndex),
    hideLargeResultWarnings: booleanSetting(
      config.get<boolean>('hideLargeResultWarnings'),
      DEFAULT_PANEL_SETTINGS.hideLargeResultWarnings
    ),
    hideLargeSortWarnings: booleanSetting(
      config.get<boolean>('hideLargeSortWarnings'),
      DEFAULT_PANEL_SETTINGS.hideLargeSortWarnings
    ),
    elapsedTimeDisplay: panelElapsedTimeDisplay(config.get<string>('elapsedTimeDisplay')),
  };
}

function panelSizeSettings(
  config: vscode.WorkspaceConfiguration,
  density: KdbPanelDensity
): Pick<KdbPanelSettings, 'cellWidth' | 'rowHeight' | 'fontSize'> {
  const defaults = DEFAULT_DENSITY_SIZE_SETTINGS[density];
  return {
    cellWidth: densitySizeSetting(config, density, 'cellWidth', defaults.cellWidth, DEFAULT_PANEL_SETTINGS.cellWidth, 80, 600),
    rowHeight: densitySizeSetting(config, density, 'rowHeight', defaults.rowHeight, DEFAULT_PANEL_SETTINGS.rowHeight, 20, 80),
    fontSize: densitySizeSetting(config, density, 'fontSize', defaults.fontSize, DEFAULT_PANEL_SETTINGS.fontSize, 0, 32),
  };
}

function densitySizeSetting(
  config: vscode.WorkspaceConfiguration,
  density: KdbPanelDensity,
  key: 'cellWidth' | 'rowHeight' | 'fontSize',
  densityDefault: number,
  legacyDefault: number,
  min: number,
  max: number
): number {
  const densityKey = `${density}.${key}`;
  return panelSizeSettingValue(
    config.get<number>(densityKey),
    config.inspect<number>(densityKey),
    config.get<number>(key),
    config.inspect<number>(key),
    densityDefault,
    legacyDefault,
    min,
    max
  );
}

function panelSizeSettingValue(
  densityValue: any,
  densityInspection: any,
  legacyValue: any,
  legacyInspection: any,
  densityDefault: number,
  legacyDefault: number,
  min: number,
  max: number
): number {
  if (hasConfiguredSettingValue(densityInspection)) {
    return boundedSettingNumber(densityValue, densityDefault, min, max);
  }

  if (hasConfiguredSettingValue(legacyInspection)) {
    return boundedSettingNumber(legacyValue, legacyDefault, min, max);
  }

  return boundedSettingNumber(densityValue, densityDefault, min, max);
}

function hasConfiguredSettingValue(inspection: any): boolean {
  return !!inspection && (
    inspection.globalValue !== undefined ||
    inspection.workspaceValue !== undefined ||
    inspection.workspaceFolderValue !== undefined
  );
}

function panelSettingConfigKey(key: string, density: KdbPanelDensity): string {
  return key === 'cellWidth' || key === 'rowHeight' || key === 'fontSize'
    ? `${density}.${key}`
    : key;
}

function panelTitle(panelNumber: number): string {
  return panelNumber <= 1 ? 'kdb Results' : `kdb Results ${panelNumber}`;
}

function initialResultViewColumn(): vscode.ViewColumn {
  const value = vscode.workspace
    .getConfiguration('kdb-sqltools.results.kdbPanel')
    .get<string>('initialViewColumn', 'active');
  switch (value) {
    case 'beside':
      return vscode.ViewColumn.Beside;
    case 'one':
      return vscode.ViewColumn.One;
    case 'two':
      return vscode.ViewColumn.Two;
    case 'three':
      return vscode.ViewColumn.Three;
    case 'active':
    default:
      return vscode.ViewColumn.Active;
  }
}

type PanelSettingUpdateValue = string | number | boolean;
type PanelSettingUpdateValidator = (value: any) => PanelSettingUpdateValue | null;

const RESULT_SETTING_UPDATE_ALLOWLIST: { [key: string]: PanelSettingUpdateValidator } = {
  cellWidth: value => numberSettingUpdate(value, 80, 600),
  rowHeight: value => numberSettingUpdate(value, 20, 80),
  fontSize: value => numberSettingUpdate(value, 0, 32),
  density: densitySettingUpdate,
  showRowIndex: booleanSettingUpdate,
  includeHeaders: booleanSettingUpdate,
  includeRowIndex: booleanSettingUpdate,
  hideLargeResultWarnings: booleanSettingUpdate,
  hideLargeSortWarnings: booleanSettingUpdate,
  elapsedTimeDisplay: elapsedTimeDisplaySettingUpdate,
};

function normalizePanelSettingUpdate(key: any, value: any): { key: string; value: PanelSettingUpdateValue } | null {
  if (typeof key !== 'string') {
    return null;
  }

  const validator = Object.prototype.hasOwnProperty.call(RESULT_SETTING_UPDATE_ALLOWLIST, key)
    ? RESULT_SETTING_UPDATE_ALLOWLIST[key]
    : undefined;
  if (!validator) {
    return null;
  }

  const normalized = validator(value);
  return normalized === null ? null : { key, value: normalized };
}

function boundedSettingNumber(value: any, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(number), min), max);
}

function booleanSetting(value: any, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function panelDensity(value: any): KdbPanelDensity {
  return value === 'compact' || value === 'comfortable' ? value : 'standard';
}

function panelElapsedTimeDisplay(value: any): KdbPanelElapsedTimeDisplay {
  return value === 'milliseconds' ? 'milliseconds' : 'auto';
}

function numberSettingUpdate(value: any, min: number, max: number): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.min(Math.max(Math.floor(number), min), max);
}

function densitySettingUpdate(value: any): string | null {
  return value === 'compact' || value === 'standard' || value === 'comfortable' ? value : null;
}

function elapsedTimeDisplaySettingUpdate(value: any): string | null {
  return value === 'auto' || value === 'milliseconds' ? value : null;
}

function booleanSettingUpdate(value: any): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function columnNameLookup(columnNames: string[]): { [name: string]: boolean } {
  const lookup: { [name: string]: boolean } = Object.create(null);
  columnNames.forEach(column => {
    lookup[column] = true;
  });
  return lookup;
}

function sameColumnNames(left: string[] | undefined, right: string[]): boolean {
  if (!left || left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function moveColumnName(columns: string[], sourceColumnName: string, targetColumnName: string): string[] {
  const sourceIndex = columns.indexOf(sourceColumnName);
  const targetIndex = columns.indexOf(targetColumnName);
  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
    return columns.slice();
  }

  const next = columns.slice();
  const moved = next.splice(sourceIndex, 1)[0];
  next.splice(targetIndex, 0, moved);
  return next;
}

function mergeVisibleColumnOrder(fullOrder: string[], visibleOrder: string[], hiddenColumns: string[]): string[] {
  const hidden = columnNameLookup(hiddenColumns);
  const visible = visibleOrder.slice();
  let visibleIndex = 0;
  return fullOrder.map(column => {
    if (hidden[column]) {
      return column;
    }
    const next = visible[visibleIndex];
    visibleIndex += 1;
    return next || column;
  });
}

function nextSortState(current: KdbPanelSortState | undefined, columnName: string): KdbPanelSortState | undefined {
  if (!current || current.columnName !== columnName) {
    return { columnName, direction: 'asc' };
  }

  if (current.direction === 'asc') {
    return { columnName, direction: 'desc' };
  }

  return undefined;
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
    case 'markdown':
    case 'tsv':
      return value;
  }
  return 'csv';
}

function exportFormat(value: any): ExportFormat {
  switch (value) {
    case 'csv':
    case 'xlsx':
    case 'json':
    case 'ndjson':
    case 'html':
    case 'markdown':
    case 'tsv':
      return value;
  }
  return 'csv';
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
    case 'markdown':
      return { Markdown: ['md', 'markdown'] };
    case 'tsv':
      return { TSV: ['tsv'] };
  }
}

function defaultExportUri(format: ExportFormat): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : os.homedir();
  const extension = format === 'markdown' ? 'md' : format;
  return vscode.Uri.file(path.join(folder, `kdb-results.${extension}`));
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCount(count: number): string {
  return String(Math.floor(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function resultSizeGuardrailMessage(rowCount: number, columnCount: number): string | undefined {
  const cells = rowCount * columnCount;
  if (
    cells < LARGE_RESULT_WARNING_CELL_THRESHOLD &&
    rowCount < LARGE_RESULT_WARNING_ROW_THRESHOLD &&
    columnCount < LARGE_RESULT_WARNING_COLUMN_THRESHOLD
  ) {
    return undefined;
  }

  return `Large result: ${formatCount(rowCount)} rows x ${formatCount(columnCount)} columns ` +
    `(${formatCount(cells)} cells). Viewing is not blocked, but copy/export/search/sort may take longer.`;
}

function estimateCopyExport(
  result: ColumnarPanelResult,
  range: CellRange,
  format: ExportFormat,
  includeHeaders: boolean,
  includeRowIndex: boolean
): CopyExportEstimate {
  const shape = exportShape(range, { includeHeaders, includeRowIndex });
  const averageCellBytes = estimateAverageCellBytes(result, range, shape.selectedRows, shape.selectedColumns);
  const estimatedDataBytes = shape.selectedCells * (averageCellBytes + formatCellOverhead(format));
  const estimatedHeaderBytes = includeHeaders
    ? estimateHeaderBytes(result, range, includeRowIndex) + shape.outputColumns * formatCellOverhead(format)
    : 0;
  const estimatedRowIndexBytes = includeRowIndex ? estimateRowIndexBytes(range, shape.selectedRows) : 0;
  const estimatedBytes = Math.ceil(
    estimatedDataBytes +
    estimatedHeaderBytes +
    estimatedRowIndexBytes +
    shape.outputRows * formatRowOverhead(format) +
    formatDocumentOverhead(format)
  );

  return {
    selectedRows: shape.selectedRows,
    selectedColumns: shape.selectedColumns,
    outputRows: shape.outputRows,
    outputColumns: shape.outputColumns,
    selectedCells: shape.selectedCells,
    outputCells: shape.outputCells,
    estimatedBytes,
  };
}

function largeCopyExportConfirmationMessage(
  action: 'copy' | 'export',
  format: ExportFormat,
  estimate: CopyExportEstimate
): string | undefined {
  if (
    estimate.selectedCells < COPY_EXPORT_CONFIRM_CELL_THRESHOLD &&
    estimate.estimatedBytes < COPY_EXPORT_CONFIRM_BYTES
  ) {
    return undefined;
  }

  const actionLabel = action === 'copy' ? 'Copy' : 'Export';
  return `${actionLabel} ${format.toUpperCase()} selection is large: ` +
    `${formatCount(estimate.selectedRows)} rows x ${formatCount(estimate.selectedColumns)} columns ` +
    `(${formatCount(estimate.selectedCells)} cells; estimated ${formatBytes(estimate.estimatedBytes)}). ` +
    `Continue?`;
}

function estimateAverageCellBytes(
  result: ColumnarPanelResult,
  range: CellRange,
  selectedRows: number,
  selectedColumns: number
): number {
  if (selectedRows <= 0 || selectedColumns <= 0) {
    return 4;
  }

  const sampledRows = Math.min(selectedRows, COPY_EXPORT_SAMPLE_ROWS);
  const sampledColumns = Math.min(selectedColumns, COPY_EXPORT_SAMPLE_COLUMNS);
  const rowStep = Math.max(1, Math.floor(selectedRows / sampledRows));
  const columnStep = Math.max(1, Math.floor(selectedColumns / sampledColumns));
  let sampledCells = 0;
  let sampledBytes = 0;

  for (let rowOffset = 0; rowOffset < selectedRows && sampledCells < sampledRows * sampledColumns; rowOffset += rowStep) {
    const rowIndex = Math.min(range.endRow, range.startRow + rowOffset);
    for (let columnOffset = 0; columnOffset < selectedColumns && sampledCells < sampledRows * sampledColumns; columnOffset += columnStep) {
      const columnIndex = Math.min(range.endColumn, range.startColumn + columnOffset);
      sampledBytes += Buffer.byteLength(result.cellText(rowIndex, columnIndex), 'utf8');
      sampledCells += 1;
    }
  }

  return sampledCells > 0 ? Math.max(4, sampledBytes / sampledCells) : 4;
}

function estimateHeaderBytes(result: ColumnarPanelResult, range: CellRange, includeRowIndex: boolean): number {
  let bytes = includeRowIndex ? Buffer.byteLength(rowIndexColumnName(result.columns, range), 'utf8') : 0;
  for (let columnIndex = range.startColumn; columnIndex <= range.endColumn; columnIndex++) {
    bytes += Buffer.byteLength(result.columns[columnIndex], 'utf8');
  }
  return bytes;
}

function estimateRowIndexBytes(range: CellRange, selectedRows: number): number {
  if (selectedRows <= 0) {
    return 0;
  }
  const first = range.startRow + 1;
  const last = range.endRow + 1;
  const averageDigits = (String(first).length + String(last).length) / 2;
  return Math.ceil(selectedRows * averageDigits);
}

function formatCellOverhead(format: ExportFormat): number {
  switch (format) {
    case 'html':
      return 18;
    case 'json':
    case 'ndjson':
      return 10;
    case 'markdown':
      return 4;
    case 'xlsx':
      return 64;
    case 'csv':
    case 'tsv':
      return 2;
  }
}

function formatRowOverhead(format: ExportFormat): number {
  switch (format) {
    case 'html':
      return 12;
    case 'markdown':
      return 4;
    case 'json':
      return 4;
    case 'xlsx':
      return 18;
    case 'csv':
    case 'tsv':
    case 'ndjson':
      return 1;
  }
}

function formatDocumentOverhead(format: ExportFormat): number {
  switch (format) {
    case 'html':
      return 64;
    case 'markdown':
      return 32;
    case 'xlsx':
      return 2048;
    case 'json':
      return 2;
    case 'csv':
    case 'tsv':
    case 'ndjson':
      return 0;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function columnarToXlsx(
  result: ColumnarPanelResult,
  range: CellRange,
  includeHeaders: boolean,
  includeRowIndex: boolean
): Promise<Uint8Array> {
  const limitError = validateXlsxSheetLimits(range, { includeHeaders, includeRowIndex });
  if (limitError) {
    throw new Error(limitError);
  }

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
  zip.file('xl/worksheets/sheet1.xml', sheetXml(result, range, includeHeaders, includeRowIndex));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

function sheetXml(
  result: ColumnarPanelResult,
  range: CellRange,
  includeHeaders: boolean,
  includeRowIndex: boolean
): string {
  const selectedRows = range.endRow - range.startRow + 1;
  const selectedColumns = range.endColumn - range.startColumn + 1 + (includeRowIndex ? 1 : 0);
  const outputRows = selectedRows + (includeHeaders ? 1 : 0);
  const dimension = `A1:${excelColumnName(selectedColumns - 1)}${Math.max(outputRows, 1)}`;
  return xmlDeclaration() +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="${dimension}"/>` +
    '<sheetData>' +
    sheetRowsXml(result, range, includeHeaders, includeRowIndex) +
    '</sheetData>' +
    '</worksheet>';
}

function sheetRowsXml(
  result: ColumnarPanelResult,
  range: CellRange,
  includeHeaders: boolean,
  includeRowIndex: boolean
): string {
  const parts: string[] = [];
  let outputRow = 1;
  if (includeHeaders) {
    const headers: string[] = [];
    if (includeRowIndex) {
      headers.push(cellValueToText(rowIndexColumnName(result.columns, range)));
    }
    for (let columnIndex = range.startColumn; columnIndex <= range.endColumn; columnIndex++) {
      headers.push(cellValueToText(result.columns[columnIndex]));
    }
    parts.push(sheetRowXml(outputRow, headers));
    outputRow += 1;
  }

  for (let rowIndex = range.startRow; rowIndex <= range.endRow; rowIndex++) {
    const values: string[] = [];
    if (includeRowIndex) {
      values.push(String(rowIndex + 1));
    }
    for (let columnIndex = range.startColumn; columnIndex <= range.endColumn; columnIndex++) {
      values.push(result.cellText(rowIndex, columnIndex));
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
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F&<>"']/g, char => {
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
    return '';
  });
}
