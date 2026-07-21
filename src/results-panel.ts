import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import JSZip = require('jszip');
import {
  CHART_MAX_SOURCE_ROWS,
  CHART_ZOOM_MAX_SAMPLED_POINTS,
  CHART_ZOOM_MIN_SAMPLED_POINTS,
  ChartDataError,
  ChartType,
  buildChartData,
  chartColumnOptions,
  normalizeChartType,
} from './charting';
import {
  ArrayDisplayFormat,
  CellRange,
  CellTextOptions,
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
import {
  LOCAL_DATA_SERVER_FULL_EXPORT_CELL_LIMIT,
  LocalDataServer,
  LocalDataServerEndpoint,
  LocalDataServerInfo,
  LocalDataServerSnapshot,
  localDataServerFullExportCellLimitValue,
} from './local-data-server';
import { endPerfSpan, isPerfTraceEnabled, perfSpan } from './perf';

type KdbPanelResultMode = 'table' | 'text';

interface KdbPanelBaseResult {
  query: string;
  connectionName: string;
  elapsedMs: number;
  messages: string[];
  error?: boolean;
  canceled?: boolean;
}

export interface KdbPanelTableResult extends KdbPanelBaseResult {
  mode?: 'table';
  table: ColumnarPanelResult;
}

export interface KdbPanelTextResult extends KdbPanelBaseResult {
  mode: 'text';
  text: string;
}

export type KdbPanelResult = KdbPanelTableResult | KdbPanelTextResult;

interface LoadingState {
  query: string;
  connectionName: string;
}

interface KdbPanelMetadata {
  mode: KdbPanelResultMode;
  columns: string[];
  allColumns: string[];
  hiddenColumnCount: number;
  hiddenColumnNames: string[];
  rowCount: number;
  text?: string;
  query: string;
  connectionName: string;
  elapsedMs: number;
  messages: string[];
  error?: boolean;
  canceled?: boolean;
  version: number;
  settings: KdbPanelSettings;
  sort: KdbPanelSortState | null;
  guardrailMessage?: string;
  chartAutoOpen?: boolean;
}

type KdbPanelDensity = 'compact' | 'standard' | 'comfortable';
type KdbPanelElapsedTimeDisplay = 'auto' | 'milliseconds';
type KdbPanelQResultDisplayStrategy = 'grid' | 'qText';
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
  copyExportConfirmCellThreshold: number;
  localDataServerFullExportCellLimit: number;
  elapsedTimeDisplay: KdbPanelElapsedTimeDisplay;
  chartDecimalPlaces: number;
  chartZoomMinSampledPoints: number;
  chartZoomMaxSampledPoints: number;
  arrayDisplayFormat: ArrayDisplayFormat;
  functionDisplayStrategy: KdbPanelQResultDisplayStrategy;
  dictionaryDisplayStrategy: KdbPanelQResultDisplayStrategy;
  listDisplayStrategy: KdbPanelQResultDisplayStrategy;
  objectDisplayStrategy: KdbPanelQResultDisplayStrategy;
}

interface SavedChartSelection {
  chartType: ChartType;
  xColumn: string;
  yColumns: string[];
  groupByColumn?: string;
  openColumn?: string;
  highColumn?: string;
  lowColumn?: string;
  closeColumn?: string;
}

interface ChartRange {
  readonly min: number;
  readonly max: number;
}

interface KdbPanelShowOptions {
  autoChart?: boolean;
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
const CHART_PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const CHART_EXPORT_MAX_BYTES = 50 * 1024 * 1024;
const CHART_DECIMAL_PLACES_DEFAULT = 4;
const CHART_DECIMAL_PLACES_MIN = 0;
const CHART_DECIMAL_PLACES_MAX = 12;
const CHART_SELECTION_STATE_PREFIX = 'kdb-sqltools.results.kdbPanel.chartSelection.v1.';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
  copyExportConfirmCellThreshold: COPY_EXPORT_CONFIRM_CELL_THRESHOLD,
  localDataServerFullExportCellLimit: LOCAL_DATA_SERVER_FULL_EXPORT_CELL_LIMIT,
  elapsedTimeDisplay: 'auto',
  chartDecimalPlaces: CHART_DECIMAL_PLACES_DEFAULT,
  chartZoomMinSampledPoints: CHART_ZOOM_MIN_SAMPLED_POINTS,
  chartZoomMaxSampledPoints: CHART_ZOOM_MAX_SAMPLED_POINTS,
  arrayDisplayFormat: 'commaSpace',
  functionDisplayStrategy: 'qText',
  dictionaryDisplayStrategy: 'grid',
  listDisplayStrategy: 'grid',
  objectDisplayStrategy: 'grid',
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
  private readonly context: vscode.ExtensionContext;
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
  private localDataServer: LocalDataServer | undefined;
  private localDataServerInfo: LocalDataServerInfo | undefined;
  private selectionRange: CellRange | undefined;
  private selectionVersion = 0;
  private activeChartRequestId = 0;
  private chartPanelOpen = false;
  private chartPanelRendered = false;
  private pendingAutoChart = false;
  private runningQueryCancel: { version: number; cancel(): void } | undefined;

  public static showLoading(
    context: vscode.ExtensionContext,
    state: LoadingState,
    mode: KdbResultsPanelRunMode = 'replace',
    options: KdbPanelShowOptions = {}
  ): KdbResultsPanel {
    const panel = KdbResultsPanel.ensure(context, mode);
    const autoChart = options.autoChart === true || (mode === 'replace' && panel.chartPanelRendered);
    panel.cancelRunningQuery();
    panel.version += 1;
    panel.firstSliceVersion = 0;
    panel.rowOrder = undefined;
    panel.sortState = undefined;
    panel.hideLargeResultWarningOnce = false;
    panel.baseVisibleTableCache = undefined;
    panel.visibleTableCache = undefined;
    panel.selectionRange = undefined;
    panel.selectionVersion = panel.version;
    panel.activeChartRequestId += 1;
    panel.chartPanelRendered = false;
    panel.pendingAutoChart = autoChart;
    panel.loading = state;
    panel.result = undefined;
    panel.revealExisting();
    panel.post({ type: 'loading', state: { ...state, version: panel.version, settings: panelSettings() } });
    panel.postLocalDataServerStatus();
    return panel;
  }

  public static showResult(
    context: vscode.ExtensionContext,
    result: KdbPanelResult,
    mode: KdbResultsPanelRunMode = 'replace',
    options: KdbPanelShowOptions = {}
  ): KdbResultsPanel {
    const panel = KdbResultsPanel.ensure(context, mode);
    panel.pendingAutoChart = options.autoChart === true || (mode === 'replace' && panel.chartPanelRendered);
    panel.showResult(result);
    return panel;
  }

  public showResult(result: KdbPanelResult): KdbResultsPanel {
    if (this.disposed) {
      return this;
    }
    this.clearRunningQueryCancel();
    this.version += 1;
    this.firstSliceVersion = 0;
    this.rowOrder = undefined;
    this.sortState = undefined;
    this.hideLargeResultWarningOnce = false;
    this.baseVisibleTableCache = undefined;
    this.visibleTableCache = undefined;
    this.selectionRange = undefined;
    this.selectionVersion = this.version;
    this.activeChartRequestId += 1;
    this.chartPanelRendered = false;
    this.loading = undefined;
    if (isTextPanelResult(result)) {
      this.hiddenColumnNames = [];
      this.hiddenColumnSchema = [];
      this.columnOrder = undefined;
      this.columnOrderSchema = [];
    } else {
      this.hiddenColumnNames = this.hiddenColumnNamesForNewResult(result.table.columns);
      this.hiddenColumnSchema = result.table.columns.slice();
      this.columnOrder = this.columnOrderForNewResult(result.table.columns);
      this.columnOrderSchema = result.table.columns.slice();
    }
    this.result = result;
    this.revealExisting();
    this.postResultMetadata();
    return this;
  }

  public currentVersion(): number {
    return this.version;
  }

  public isLoadingVersion(version: number): boolean {
    return !this.disposed && !!this.loading && this.version === version;
  }

  public setLoadingCancelHandler(version: number, cancel: () => void): vscode.Disposable {
    const handler = { version, cancel };
    if (!this.disposed && this.loading && this.version === version) {
      this.runningQueryCancel = handler;
    }
    return new vscode.Disposable(() => {
      if (this.runningQueryCancel === handler) {
        this.runningQueryCancel = undefined;
      }
    });
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

  public static async openLocalDataServerForActivePanel(): Promise<void> {
    const panel = KdbResultsPanel.reusablePanel();
    if (!panel) {
      vscode.window.showWarningMessage('Open a kdb result panel before starting the local data server.');
      return;
    }
    await panel.startLocalDataServer();
  }

  public static async stopLocalDataServerForActivePanel(): Promise<void> {
    const panel = KdbResultsPanel.reusablePanel();
    if (!panel) {
      vscode.window.showWarningMessage('Open a kdb result panel before stopping the local data server.');
      return;
    }
    await panel.stopLocalDataServer('Local data server stopped.');
  }

  public static async copyLocalDataServerUrlFromActivePanel(endpoint: LocalDataServerEndpoint = 'current.csv'): Promise<void> {
    const panel = KdbResultsPanel.reusablePanel();
    if (!panel) {
      vscode.window.showWarningMessage('Open a kdb result panel before copying a local data server URL.');
      return;
    }
    await panel.copyLocalDataServerUrl(endpoint);
  }

  public static stopAllLocalDataServers(): void {
    KdbResultsPanel.panels.forEach(panel => {
      panel.stopLocalDataServer('Local data server stopped.').catch(error => {
        console.error(toError(error).message);
      });
    });
  }

  private constructor(context: vscode.ExtensionContext, viewColumn: vscode.ViewColumn = initialResultViewColumn()) {
    this.context = context;
    const panelNumber = KdbResultsPanel.nextPanelNumber++;
    const uplotDistRoot = vscode.Uri.file(path.join(context.extensionPath, 'node_modules', 'uplot', 'dist'));
    this.panel = vscode.window.createWebviewPanel(
      'kdbSqltoolsResults',
      panelTitle(panelNumber),
      { viewColumn, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [uplotDistRoot],
      }
    );
    KdbResultsPanel.panels.push(this);
    KdbResultsPanel.lastActivePanel = this;
    this.panel.webview.html = this.html(context, this.panel.webview);
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
    this.cancelRunningQuery();
    this.stopLocalDataServer('Local data server stopped.').catch(error => {
      console.error(toError(error).message);
    });
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
    this.activeChartRequestId += 1;
    this.chartPanelOpen = false;
    this.chartPanelRendered = false;
    this.pendingAutoChart = false;
    this.selectionRange = undefined;
    this.selectionVersion = 0;
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
        this.postLocalDataServerStatus();
      }
      return;
    }

    if (message.type === 'cancelRunningQuery') {
      const requestVersion = integerOrNull(message.version);
      if (requestVersion !== null && requestVersion === this.version && this.loading) {
        this.cancelRunningQuery(requestVersion);
      }
      return;
    }

    if (message.type === 'tableContextMenu') {
      KdbResultsPanel.lastActivePanel = this;
      return;
    }

    if (message.type === 'selectionChanged') {
      this.updateSelectionFromWebview(message);
      return;
    }

    if (message.type === 'startLocalDataServer') {
      await this.startLocalDataServer();
      return;
    }

    if (message.type === 'stopLocalDataServer') {
      await this.stopLocalDataServer('Local data server stopped.');
      return;
    }

    if (message.type === 'copyLocalDataServerUrl') {
      await this.copyLocalDataServerUrl(localDataServerEndpoint(message.endpoint));
      return;
    }

    if (message.type === 'requestChartOptions') {
      this.postChartOptions(message);
      return;
    }

    if (message.type === 'requestChart') {
      await this.postChartData(message);
      return;
    }

    if (message.type === 'chartPanelState') {
      this.updateChartPanelState(message);
      return;
    }

    if (message.type === 'chartRendered') {
      await this.saveRenderedChartSelection(message);
      return;
    }

    if (message.type === 'exportChartPng') {
      await this.exportChartPng(message);
      return;
    }

    if (message.type === 'copyText') {
      await this.copyText(message.version);
      return;
    }

    if (message.type === 'exportText') {
      await this.exportText(message.version);
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
    const result = this.result;
    const tracePerf = isPerfTraceEnabled();
    const tableResult = isTextPanelResult(result) ? null : result;
    const table = tableResult ? tableResult.table : null;
    const span = tracePerf ? perfSpan('results-panel.metadata.post', {
        version: this.version,
        rows: table ? table.rowCount : 0,
        columns: tableResult ? this.visibleColumnNames(tableResult).length : 0,
        totalColumns: table ? table.columns.length : 0,
        mode: table ? 'table' : 'text',
        ready: this.ready,
      }) : null;
    try {
      this.post({ type: 'resultMeta', result: this.metadataForResult(this.result) });
      this.postLocalDataServerStatus();
    } finally {
      if (tracePerf) {
        endPerfSpan(span, { posted: this.ready });
      }
    }
  }

  private metadataForResult(result: KdbPanelResult): KdbPanelMetadata {
    if (isTextPanelResult(result)) {
      const settings = panelSettings();
      return {
        mode: 'text',
        columns: [],
        allColumns: [],
        hiddenColumnCount: 0,
        hiddenColumnNames: [],
        rowCount: 0,
        text: result.text,
        query: result.query,
        connectionName: result.connectionName,
        elapsedMs: result.elapsedMs,
        messages: result.messages,
        error: result.error,
        canceled: result.canceled,
        version: this.version,
        settings,
        sort: null,
        chartAutoOpen: false,
      };
    }

    const columns = this.visibleColumnNames(result);
    const hiddenColumnNames = this.activeHiddenColumnNames(result);
    const settings = panelSettings();
    return {
      mode: 'table',
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
      canceled: result.canceled,
      version: this.version,
      settings,
      sort: this.visibleSortState(result),
      chartAutoOpen: this.pendingAutoChart,
      guardrailMessage: settings.hideLargeResultWarnings || this.hideLargeResultWarningOnce
        ? undefined
        : resultSizeGuardrailMessage(result.table.rowCount, result.table.columns.length),
    };
  }

  private async startLocalDataServer(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.result) {
      const message = 'Run a q result in this panel before starting the local data server.';
      vscode.window.showWarningMessage(message);
      this.post({ type: 'localDataServerMessage', message });
      return;
    }
    if (isTextPanelResult(this.result)) {
      const message = 'Local data server requires a table/grid result.';
      vscode.window.showWarningMessage(message);
      this.post({ type: 'localDataServerMessage', message });
      return;
    }

    if (!this.localDataServer) {
      this.localDataServer = new LocalDataServer({
        fullExportCellLimit: () => panelSettings().localDataServerFullExportCellLimit,
        provider: {
          current: () => this.localDataServerSnapshot(),
        },
      });
    }

    try {
      this.localDataServerInfo = await this.localDataServer.start();
      this.postLocalDataServerStatus('Local data server started.');
    } catch (error) {
      const message = `Local data server failed: ${toError(error).message}`;
      vscode.window.showErrorMessage(message);
      this.post({ type: 'localDataServerMessage', message });
    }
  }

  private cancelRunningQuery(version?: number): void {
    const handler = this.runningQueryCancel;
    if (!handler || (version !== undefined && handler.version !== version)) {
      return;
    }
    this.runningQueryCancel = undefined;
    handler.cancel();
  }

  private clearRunningQueryCancel(version?: number): void {
    if (!this.runningQueryCancel || (version !== undefined && this.runningQueryCancel.version !== version)) {
      return;
    }
    this.runningQueryCancel = undefined;
  }

  private async stopLocalDataServer(message?: string): Promise<void> {
    const server = this.localDataServer;
    this.localDataServer = undefined;
    this.localDataServerInfo = undefined;
    if (server) {
      await server.stop();
    }
    this.postLocalDataServerStatus(message);
  }

  private async copyLocalDataServerUrl(endpoint: LocalDataServerEndpoint): Promise<void> {
    if (!this.localDataServer || !this.localDataServerInfo) {
      const message = 'Start the local data server before copying a URL.';
      vscode.window.showWarningMessage(message);
      this.post({ type: 'localDataServerMessage', message });
      return;
    }

    const url = this.localDataServer.endpointUrl(endpoint);
    if (!url) {
      return;
    }
    await vscode.env.clipboard.writeText(url);
    this.postLocalDataServerStatus(`Copied ${endpoint} URL.`);
  }

  private postLocalDataServerStatus(message?: string): void {
    const info = this.localDataServerInfo;
    this.post({
      type: 'localDataServerStatus',
      server: info ? {
        host: info.host,
        port: info.port,
        baseUrl: info.baseUrl,
        currentCsvUrl: this.localDataServer && this.localDataServer.endpointUrl('current.csv'),
        metadataUrl: this.localDataServer && this.localDataServer.endpointUrl('metadata.json'),
      } : null,
      message,
    });
  }

  private localDataServerSnapshot(): LocalDataServerSnapshot | null {
    if (!this.result) {
      return null;
    }
    const table = this.visibleTable();
    if (!table) {
      return null;
    }
    return {
      metadata: this.metadataForResult(this.result),
      table,
      selectionRange: this.currentSelectionRange(table) || undefined,
      cellTextOptions: panelCellTextOptions(),
    };
  }

  private currentSelectionRange(table: ColumnarPanelResult): CellRange | null {
    if (!this.selectionRange || this.selectionVersion !== this.version) {
      return null;
    }
    return clampCellRange(this.selectionRange, table.rowCount, table.columns.length);
  }

  private updateSelectionFromWebview(message: any): void {
    const requestVersion = integerOrNull(message.version);
    if (requestVersion === null || requestVersion !== this.version) {
      return;
    }
    this.selectionVersion = requestVersion;
    this.selectionRange = messageCellRange(message.range) || undefined;
  }

  private postChartOptions(message: any): void {
    const requestVersion = integerOrNull(message.version);
    const requestId = integerOrNull(message.requestId) || 0;
    if (requestVersion === null || requestVersion !== this.version) {
      return;
    }
    const table = this.visibleTable();
    if (!table) {
      return;
    }
    const options = chartColumnOptions(table);
    this.post({
      type: 'chartOptions',
      version: requestVersion,
      requestId,
      options,
      savedSelection: this.savedChartSelection(table, options),
      autoChart: this.consumePendingAutoChart(),
    });
  }

  private async postChartData(message: any): Promise<void> {
    const requestVersion = integerOrNull(message.version);
    const requestId = integerOrNull(message.requestId);
    if (requestVersion === null || requestId === null || requestVersion !== this.version) {
      return;
    }
    const table = this.visibleTable();
    if (!table) {
      return;
    }

    this.activeChartRequestId = requestId;
    try {
      await yieldToEventLoop();
      const xMin = Number.isFinite(Number(message.xMin)) ? Number(message.xMin) : undefined;
      const xMax = Number.isFinite(Number(message.xMax)) ? Number(message.xMax) : undefined;
      const zoomSamplePoints = xMin !== undefined && xMax !== undefined ? chartZoomSamplePointSettings() : null;
      const data = buildChartData(table, {
        chartType: normalizeChartType(message.chartType),
        version: requestVersion,
        requestId,
        xColumn: typeof message.xColumn === 'string' ? message.xColumn : '',
        yColumns: Array.isArray(message.yColumns) ? message.yColumns.map(String) : [],
        groupByColumn: typeof message.groupByColumn === 'string' ? message.groupByColumn : '',
        openColumn: typeof message.openColumn === 'string' ? message.openColumn : '',
        highColumn: typeof message.highColumn === 'string' ? message.highColumn : '',
        lowColumn: typeof message.lowColumn === 'string' ? message.lowColumn : '',
        closeColumn: typeof message.closeColumn === 'string' ? message.closeColumn : '',
        xMin,
        xMax,
        width: Number(message.width) || 0,
        maxSourceRows: chartMaxSourceRowsSetting(),
        maxSampledPoints: zoomSamplePoints ? zoomSamplePoints.chartZoomMaxSampledPoints : undefined,
        minSampledPoints: zoomSamplePoints ? zoomSamplePoints.chartZoomMinSampledPoints : undefined,
      });
      if (this.version !== requestVersion || this.activeChartRequestId !== requestId) {
        return;
      }
      this.post({ type: 'chartData', data });
    } catch (error) {
      if (this.version !== requestVersion || this.activeChartRequestId !== requestId) {
        return;
      }
      const err = toError(error);
      this.post({
        type: 'chartError',
        version: requestVersion,
        requestId,
        message: error instanceof ChartDataError ? err.message : `Chart failed: ${err.message}`,
      });
    }
  }

  private updateChartPanelState(message: any): void {
    const requestVersion = integerOrNull(message.version);
    if (requestVersion === null || requestVersion !== this.version) {
      return;
    }
    this.chartPanelOpen = message.open === true;
    this.chartPanelRendered = this.chartPanelOpen && message.rendered === true;
  }

  private async saveRenderedChartSelection(message: any): Promise<void> {
    const requestVersion = integerOrNull(message.version);
    const requestId = integerOrNull(message.requestId);
    if (requestVersion === null || requestId === null ||
      requestVersion !== this.version || requestId !== this.activeChartRequestId) {
      return;
    }
    const table = this.visibleTable();
    if (!table) {
      return;
    }
    const options = chartColumnOptions(table);
    const selection = normalizeSavedChartSelection(message.selection);
    const compatible = selection ? compatibleChartSelection(selection, options) : null;
    if (!compatible) {
      return;
    }
    this.chartPanelOpen = true;
    this.chartPanelRendered = true;
    await this.context.globalState.update(chartSelectionStorageKey(table.columns), compatible);
  }

  private savedChartSelection(table: ColumnarPanelResult, options = chartColumnOptions(table)): SavedChartSelection | null {
    const saved = normalizeSavedChartSelection(this.context.globalState.get(chartSelectionStorageKey(table.columns)));
    return saved ? compatibleChartSelection(saved, options) : null;
  }

  private consumePendingAutoChart(): boolean {
    const value = this.pendingAutoChart;
    this.pendingAutoChart = false;
    return value;
  }

  private async exportChartPng(message: any): Promise<void> {
    const requestVersion = integerOrNull(message.version);
    const requestId = integerOrNull(message.requestId);
    if (requestVersion === null || requestId === null ||
      requestVersion !== this.version || requestId !== this.activeChartRequestId) {
      return;
    }

    let content: Uint8Array;
    try {
      content = chartPngBytesFromDataUrl(message.dataUrl);
    } catch (error) {
      const errorMessage = toError(error).message;
      await vscode.window.showErrorMessage(errorMessage);
      if (this.version === requestVersion && this.activeChartRequestId === requestId) {
        this.post({ type: 'chartExportError', version: requestVersion, requestId, message: errorMessage });
      }
      return;
    }

    if (this.version !== requestVersion || this.activeChartRequestId !== requestId) {
      return;
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: defaultChartExportUri(),
      filters: { PNG: ['png'] },
      saveLabel: 'Export',
    });
    if (this.version !== requestVersion || this.activeChartRequestId !== requestId) {
      return;
    }
    if (!uri) {
      this.post({ type: 'chartExportSkipped', version: requestVersion, requestId, message: 'Chart export canceled.' });
      return;
    }

    try {
      await vscode.workspace.fs.writeFile(uri, content);
    } catch (error) {
      const errorMessage = `Chart export failed: ${toError(error).message}`;
      await vscode.window.showErrorMessage(errorMessage);
      if (this.version === requestVersion && this.activeChartRequestId === requestId) {
        this.post({ type: 'chartExportError', version: requestVersion, requestId, message: errorMessage });
      }
      return;
    }
    if (this.version !== requestVersion || this.activeChartRequestId !== requestId) {
      return;
    }
    this.post({ type: 'chartExported', version: requestVersion, requestId, message: 'Chart exported / saved.' });
  }

  private baseVisibleTable(): ColumnarPanelResult | null {
    if (!this.result || isTextPanelResult(this.result)) {
      return null;
    }

    const result = this.result;
    if (
      this.baseVisibleTableCache &&
      this.baseVisibleTableCache.version === this.version &&
      this.baseVisibleTableCache.source === result.table
    ) {
      return this.baseVisibleTableCache.table;
    }

    const table = filterColumnarPanelResult(result.table, this.visibleColumnNames(result));
    this.baseVisibleTableCache = { version: this.version, source: result.table, table };
    return table;
  }

  private visibleTable(): ColumnarPanelResult | null {
    if (!this.result || isTextPanelResult(this.result)) {
      return null;
    }

    const result = this.result;
    const table = this.baseVisibleTable();
    if (!table || !this.rowOrder) {
      return table;
    }

    if (
      this.visibleTableCache &&
      this.visibleTableCache.version === this.version &&
      this.visibleTableCache.source === result.table
    ) {
      return this.visibleTableCache.table;
    }

    const orderedTable = applyColumnarRowOrder(table, this.rowOrder);
    this.visibleTableCache = { version: this.version, source: result.table, table: orderedTable };
    return orderedTable;
  }

  private visibleSortState(result: KdbPanelTableResult): KdbPanelSortState | null {
    if (!this.sortState) {
      return null;
    }

    return this.visibleColumnNames(result).indexOf(this.sortState.columnName) === -1
      ? null
      : { ...this.sortState };
  }

  private visibleColumnNames(result: KdbPanelTableResult): string[] {
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

  private activeHiddenColumnNames(result: KdbPanelTableResult): string[] {
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
      const cellTextOptions = panelCellTextOptions();
      const slice = table.cellWindow(rowRange, columnRange, cellTextOptions);
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
    const cellTextOptions = panelCellTextOptions();

    try {
      const needle = query.toLowerCase();
      if (needle.length > 0 && table.rowCount > 0 && table.columns.length > 0) {
        const startedMs = Date.now();
        for (let rowIndex = 0; rowIndex < table.rowCount; rowIndex++) {
          let rowMatched = false;
          for (let columnIndex = 0; columnIndex < table.columns.length; columnIndex++) {
            scannedCells += 1;
            if (table.cellText(rowIndex, columnIndex, cellTextOptions).toLowerCase().indexOf(needle) !== -1) {
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
        sortedRowOrder = sortedColumnarRowOrder(table, columnIndex, nextSort.direction, panelCellTextOptions());
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

    const cellTextOptions = panelCellTextOptions();
    const estimate = estimateCopyExport(table, clamped, format, includeHeaders, includeRowIndex, cellTextOptions);
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
      arrayDisplayFormat: cellTextOptions.arrayDisplayFormat,
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

    const cellTextOptions = panelCellTextOptions();
    const estimate = estimateCopyExport(table, clamped, format, includeHeaders, includeRowIndex, cellTextOptions);
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
      ? await columnarToXlsx(table, clamped, includeHeaders, includeRowIndex, cellTextOptions)
      : Buffer.from(table.toText(format, clamped, {
        includeHeaders,
        includeRowIndex,
        arrayDisplayFormat: cellTextOptions.arrayDisplayFormat,
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

  private async copyText(version: any): Promise<void> {
    const requestVersion = integerOrNull(version);
    if (requestVersion === null || requestVersion !== this.version || !this.result || !isTextPanelResult(this.result)) {
      return;
    }

    await vscode.env.clipboard.writeText(this.result.text);
    if (!this.isCurrentVersion(requestVersion)) {
      return;
    }
    this.post({ type: 'textCopied', version: requestVersion });
  }

  private async exportText(version: any): Promise<void> {
    const requestVersion = integerOrNull(version);
    if (requestVersion === null || requestVersion !== this.version || !this.result || !isTextPanelResult(this.result)) {
      return;
    }

    const text = this.result.text;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: defaultTextExportUri(),
      filters: { Text: ['txt'] },
      saveLabel: 'Export',
    });
    if (!this.isCurrentVersion(requestVersion)) {
      return;
    }
    if (!uri) {
      this.post({ type: 'exportSkipped', version: requestVersion, format: 'txt' });
      return;
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    if (!this.isCurrentVersion(requestVersion)) {
      return;
    }
    this.post({ type: 'textExported', version: requestVersion });
  }

  private async confirmLargeCopyExport(
    action: 'copy' | 'export',
    format: ExportFormat,
    estimate: CopyExportEstimate
  ): Promise<boolean> {
    const message = largeCopyExportConfirmationMessage(action, format, estimate, panelSettings().copyExportConfirmCellThreshold);
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
    if (requestVersion === null || !this.result || isTextPanelResult(this.result) || requestVersion !== this.version) {
      return;
    }
    const result = this.result;

    const sourceColumnName = typeof message.sourceColumnName === 'string' ? message.sourceColumnName : '';
    const targetColumnName = typeof message.targetColumnName === 'string' ? message.targetColumnName : '';
    if (!sourceColumnName || !targetColumnName || sourceColumnName === targetColumnName) {
      return;
    }

    const visibleColumns = this.visibleColumnNames(result);
    if (visibleColumns.indexOf(sourceColumnName) === -1 || visibleColumns.indexOf(targetColumnName) === -1) {
      return;
    }

    const nextVisibleColumns = moveColumnName(visibleColumns, sourceColumnName, targetColumnName);
    if (sameColumnNames(visibleColumns, nextVisibleColumns)) {
      return;
    }

    this.columnOrder = mergeVisibleColumnOrder(
      this.orderedColumnNames(result.table.columns),
      nextVisibleColumns,
      this.hiddenColumnNames
    );
    this.columnOrderSchema = result.table.columns.slice();
    this.refreshResultView();
  }

  private updateColumnVisibility(message: any): void {
    if (!this.result || isTextPanelResult(this.result)) {
      return;
    }
    const result = this.result;

    if (message.type === 'resetHiddenColumns' || message.type === 'showAllColumns') {
      if (this.hiddenColumnNames.length > 0) {
        this.hiddenColumnNames = [];
        this.refreshResultView();
      }
      return;
    }

    if (message.type === 'hideAllColumns') {
      this.hiddenColumnSchema = result.table.columns.slice();
      this.hiddenColumnNames = result.table.columns.slice();
      this.rowOrder = undefined;
      this.sortState = undefined;
      this.refreshResultView();
      return;
    }

    const columnName = typeof message.columnName === 'string' ? message.columnName : '';
    if (!columnName || result.table.columns.indexOf(columnName) === -1) {
      return;
    }

    if (message.type === 'hideColumn') {
      if (this.hiddenColumnNames.indexOf(columnName) === -1) {
        this.hiddenColumnSchema = result.table.columns.slice();
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
        this.hiddenColumnSchema = result.table.columns.slice();
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
    this.selectionRange = undefined;
    this.selectionVersion = this.version;
    this.activeChartRequestId += 1;
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

  private html(context: vscode.ExtensionContext, webview: vscode.Webview): string {
    const nonce = nonceValue();
    const cspSource = webview.cspSource;
    const uplotScriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(
      context.extensionPath,
      'node_modules',
      'uplot',
      'dist',
      'uPlot.iife.min.js'
    )));
    const uplotStyleUri = webview.asWebviewUri(vscode.Uri.file(path.join(
      context.extensionPath,
      'node_modules',
      'uplot',
      'dist',
      'uPlot.min.css'
    )));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}' 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>kdb Results</title>
  <link rel="stylesheet" href="${uplotStyleUri}">
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
      flex-wrap: nowrap;
      white-space: nowrap;
      overflow: visible;
    }
    .toolbar-group {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      margin: 0;
    }
    .output-group {
      flex: 0 0 auto;
      padding: 3px 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 2px;
      background: var(--vscode-editor-background);
    }
    .toolbar-group-label {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .output-options-slot {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
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
      min-width: 0;
      max-width: 100%;
      white-space: normal;
      overflow-wrap: anywhere;
      color: var(--vscode-descriptionForeground);
    }
    .settings,
    .tool-dropdown {
      position: relative;
      flex: 0 0 auto;
      color: var(--vscode-editor-foreground);
    }
    .settings summary,
    .tool-dropdown summary {
      display: inline-flex;
      align-items: center;
      gap: 6px;
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
    .tool-summary-status {
      max-width: 92px;
      overflow: hidden;
      color: var(--vscode-descriptionForeground);
      font-size: 0.92em;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tool-summary-status.is-running {
      color: var(--vscode-testing-iconPassed, var(--vscode-descriptionForeground));
    }
    .settings-panel,
    .tool-dropdown-panel {
      position: absolute;
      top: 30px;
      right: 0;
      z-index: 20;
      display: grid;
      gap: 8px;
      max-height: calc(100vh - 60px);
      overflow: auto;
      padding: 10px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      box-shadow: 0 4px 12px var(--vscode-widget-shadow);
      box-sizing: border-box;
    }
    .settings-panel {
      width: min(360px, calc(100vw - 20px));
      max-width: calc(100vw - 20px);
      grid-template-columns: minmax(0, 1fr);
      overflow-x: hidden;
      min-width: 0;
    }
    .settings-panel,
    .settings-panel * {
      box-sizing: border-box;
    }
    .settings-panel * {
      max-width: 100%;
      min-width: 0;
    }
    .tool-dropdown-panel {
      width: min(260px, calc(100vw - 20px));
    }
    .tool-actions {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 6px;
    }
    .tool-actions button {
      width: 100%;
      min-width: 0;
    }
    .tool-menu-status,
    .tool-menu-note {
      overflow-wrap: anywhere;
      white-space: normal;
    }
    .tool-menu-status {
      color: var(--vscode-editor-foreground);
    }
    .tool-menu-status.is-running {
      color: var(--vscode-testing-iconPassed, var(--vscode-editor-foreground));
    }
    .tool-menu-note {
      color: var(--vscode-descriptionForeground);
      line-height: 1.35;
    }
    .settings-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 3px;
      align-items: stretch;
      color: var(--vscode-descriptionForeground);
    }
    .settings-row > span {
      overflow-wrap: anywhere;
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
    .settings-section:first-child {
      padding-top: 0;
      border-top: 0;
    }
    .settings-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
      color: var(--vscode-descriptionForeground);
    }
    .settings-heading > span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
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
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 4px;
      min-width: 0;
    }
    .search input[type="search"] {
      width: 100%;
      min-width: 0;
    }
    .search button {
      padding: 0 6px;
    }
    .search-status {
      grid-column: 1 / -1;
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      max-width: none;
    }
    .summary, .selection, .status {
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .summary {
      flex: 1 1 auto;
    }
    .status, .selection {
      flex: 0 1 auto;
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
    .cancel-query[hidden] {
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
    .chart-panel {
      flex: 0 0 auto;
      display: grid;
      grid-template-rows: auto auto auto;
      gap: 8px;
      padding: 8px 10px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      box-sizing: border-box;
    }
    .chart-panel[hidden] {
      display: none;
    }
    .chart-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .chart-field {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      color: var(--vscode-descriptionForeground);
    }
    .chart-field select {
      max-width: 180px;
      min-width: 120px;
    }
    .chart-field[hidden],
    .chart-y-list[hidden],
    .chart-ohlc-fields[hidden] {
      display: none;
    }
    .chart-y-list {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
      max-width: min(520px, 100%);
    }
    .chart-ohlc-fields {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .chart-ohlc-fields .chart-field select {
      min-width: 104px;
      max-width: 150px;
    }
    .chart-y-list .checkbox {
      max-width: 180px;
    }
    .chart-y-list .checkbox span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .chart-canvas-wrap {
      position: relative;
      height: var(--chart-height, 280px);
      min-height: 180px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      overflow: hidden;
      box-sizing: border-box;
    }
    .chart-splitter {
      flex: 0 0 7px;
      cursor: ns-resize;
      border-bottom: 1px solid var(--vscode-panel-border);
      background:
        linear-gradient(
          to bottom,
          transparent 0,
          transparent 2px,
          var(--vscode-panel-border) 2px,
          var(--vscode-panel-border) 3px,
          transparent 3px
        );
      box-sizing: border-box;
    }
    .chart-splitter:hover,
    .chart-splitter.is-dragging {
      background-color: var(--vscode-list-hoverBackground);
    }
    .chart-splitter[hidden] {
      display: none;
    }
    .chart-plot,
    .chart-plot .uplot {
      width: 100%;
      height: 100%;
    }
    .chart-plot .uplot {
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
    }
    .chart-plot .u-wrap {
      background: var(--vscode-editor-background);
    }
    .chart-plot .u-axis,
    .chart-plot .u-legend {
      color: var(--vscode-descriptionForeground);
    }
    .chart-plot .u-select {
      background: var(--vscode-list-activeSelectionBackground, rgba(80, 140, 220, 0.22));
    }
    .chart-plot .u-cursor-x,
    .chart-plot .u-cursor-y {
      border-color: var(--vscode-focusBorder, #607d8b);
    }
    .chart-tooltip {
      position: absolute;
      z-index: 10;
      max-width: 260px;
      padding: 6px 8px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorHoverWidget-background, var(--vscode-sideBar-background));
      color: var(--vscode-editorHoverWidget-foreground, var(--vscode-editor-foreground));
      box-shadow: 0 2px 8px var(--vscode-widget-shadow);
      pointer-events: none;
      white-space: pre;
      box-sizing: border-box;
    }
    .chart-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .chart-legend:empty {
      display: none;
    }
    .chart-legend .u-legend {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font: inherit;
      text-align: left;
    }
    .chart-legend .u-series > * {
      padding: 2px 8px 2px 0;
    }
    .chart-legend .u-series th {
      color: var(--vscode-editor-foreground);
    }
    .chart-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }
    .chart-swatch {
      width: 14px;
      height: 3px;
      flex: 0 0 auto;
    }
    #viewport {
      position: relative;
      flex: 1;
      overflow: auto;
      outline: none;
      user-select: none;
    }
    #viewport[hidden] {
      display: none;
    }
    .text-viewport {
      flex: 1;
      overflow: auto;
      outline: none;
      user-select: text;
    }
    .text-viewport[hidden] {
      display: none;
    }
    .text-viewer {
      margin: 0;
      padding: 12px 14px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--panel-font-size);
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
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
  <div id="resultsToolbar" class="toolbar">
    <div id="outputControls" class="toolbar-group output-group" role="group" aria-labelledby="outputControlsLabel">
      <span id="outputControlsLabel" class="toolbar-group-label">Output:</span>
      <select id="actionFormat" aria-label="Copy/export format" disabled>
        <option value="csv">CSV</option>
        <option value="xlsx">XLSX</option>
        <option value="tsv">TSV</option>
        <option value="json">JSON</option>
        <option value="ndjson">NDJSON</option>
        <option value="html">HTML</option>
        <option value="markdown">Markdown</option>
      </select>
      <span id="inlineOutputOptions" class="output-options-slot">
        <label id="includeHeadersLabel" class="checkbox" title="Include column headers in copied/exported output"><input id="includeHeaders" type="checkbox" checked>Headers</label>
        <label id="includeRowIndexLabel" class="checkbox" title="Include row numbers in copied/exported output"><input id="includeRowIndex" type="checkbox" checked>Row #</label>
      </span>
      <button id="copy" disabled>Copy</button>
      <button id="export" disabled>Export</button>
    </div>
    <button id="openChart" class="chart-open-button" disabled title="Open chart" aria-label="Open chart">Chart</button>
    <details id="settingsMenu" class="settings">
      <summary id="settingsSummary" aria-label="Settings menu">Settings</summary>
      <div class="settings-panel" role="group" aria-label="Settings controls">
        <div class="settings-compact-actions">
          <button id="expandSettingsSections" type="button">Expand all</button>
          <button id="collapseSettingsSections" type="button">Collapse all</button>
        </div>
        <details class="settings-section">
          <summary class="settings-heading"><span>View</span><span id="sortStatus" class="tool-menu-note">Sort: none</span></summary>
          <label class="settings-row"><span>Header mode</span><select id="interactionMode" aria-label="Header mode">
            <option value="drag">Drag</option>
            <option value="select">Select</option>
            <option value="sort">Sort</option>
          </select></label>
          <span class="search">
            <input id="searchInput" type="search" placeholder="Search" aria-label="Search visible cells" disabled>
            <button id="searchPrev" disabled>Prev</button>
            <button id="searchNext" disabled>Next</button>
            <span id="searchStatus" class="search-status"></span>
          </span>
        </details>
        <details class="settings-section" id="dataServerSection">
          <summary class="settings-heading"><span>Data server</span><span id="localDataServerBadge" class="tool-summary-status">Stopped</span></summary>
          <div id="localDataServerStatus" class="tool-menu-status">Server stopped</div>
          <div id="localDataServerBaseUrl" class="tool-menu-note" hidden></div>
          <div id="localDataServerHelp" class="tool-menu-note">For very large current.csv/json/ndjson exports, raise the local data server full-export cell limit. Panel Copy/Export prompts use a separate confirmation threshold.</div>
          <div class="tool-actions">
            <button id="startLocalDataServer" disabled>Start server</button>
            <button id="stopLocalDataServer" disabled>Stop server</button>
            <button id="copyCurrentCsvUrl" disabled>Copy current.csv URL</button>
            <button id="copyMetadataUrl" disabled>Copy metadata URL</button>
          </div>
        </details>
        <details class="settings-section" open>
          <summary class="settings-heading"><span>Preferences</span></summary>
          <label class="checkbox"><input id="autoFit" type="checkbox" disabled>Auto-fit</label>
          <label class="checkbox"><input id="settingsShowRowIndex" type="checkbox">Show row #</label>
          <label class="checkbox"><input id="settingsIncludeHeaders" type="checkbox">Include headers</label>
          <label class="checkbox"><input id="settingsIncludeRowIndex" type="checkbox">Include row #</label>
          <label class="checkbox"><input id="settingsHideLargeResultWarnings" type="checkbox">Hide large-result warnings</label>
          <label class="checkbox"><input id="settingsHideLargeSortWarnings" type="checkbox">Hide large-sort warnings</label>
          <label class="settings-row"><span>Copy/export confirm cells</span><input id="settingsCopyExportConfirmCellThreshold" type="number" min="1" step="1"></label>
          <label class="settings-row"><span>Local server current.* cell limit</span><input id="settingsLocalDataServerFullExportCellLimit" type="number" min="1" step="1"></label>
          <label class="settings-row"><span>Chart decimals</span><input id="settingsChartDecimalPlaces" type="number" min="0" max="12" step="1" title="Decimal places for chart numeric labels, 0-12"></label>
          <label class="settings-row"><span>Elapsed time</span><select id="settingsElapsedTimeDisplay">
            <option value="auto">Auto</option>
            <option value="milliseconds">Milliseconds</option>
          </select></label>
          <label class="settings-row"><span>Arrays</span><select id="settingsArrayDisplayFormat">
            <option value="commaSpace">Comma + space</option>
            <option value="space">Spaces</option>
            <option value="raw">Raw brackets</option>
          </select></label>
          <label class="settings-row"><span>Functions</span><select id="settingsFunctionDisplayStrategy">
            <option value="grid">Grid</option>
            <option value="qText">qText</option>
          </select></label>
          <label class="settings-row"><span>Dictionaries</span><select id="settingsDictionaryDisplayStrategy">
            <option value="grid">Grid</option>
            <option value="qText">qText</option>
          </select></label>
          <label class="settings-row"><span>Lists</span><select id="settingsListDisplayStrategy">
            <option value="grid">Grid</option>
            <option value="qText">qText</option>
          </select></label>
          <label class="settings-row"><span>Objects</span><select id="settingsObjectDisplayStrategy">
            <option value="grid">Grid</option>
            <option value="qText">qText</option>
          </select></label>
          <label class="settings-row"><span>Density</span><select id="settingsDensity">
            <option value="compact">Compact</option>
            <option value="standard">Standard</option>
            <option value="comfortable">Comfortable</option>
          </select></label>
          <label class="settings-row"><span>Cell width</span><input id="settingsCellWidth" type="number" min="80" max="600" step="1"></label>
          <label class="settings-row"><span>Row height</span><input id="settingsRowHeight" type="number" min="20" max="80" step="1"></label>
          <label class="settings-row"><span>Font size</span><input id="settingsFontSize" type="number" min="0" max="32" step="1"></label>
        </details>
        <details class="settings-section">
          <summary class="settings-heading"><span>Columns</span><span id="hiddenColumns">All visible</span></summary>
          <div class="settings-actions">
            <button id="selectAllColumns" type="button">Select all</button>
            <button id="deselectAllColumns" type="button">Deselect all</button>
          </div>
          <div id="columnList" class="column-list" role="list"></div>
          <button id="resetColumns" class="reset-columns" disabled>Reset hidden columns</button>
          <button id="resetColumnWidths" class="reset-columns" disabled>Reset column widths</button>
        </details>
      </div>
    </details>
    <button id="cancelQuery" class="cancel-query" title="Cancel running q query" aria-label="Cancel running q query" hidden disabled>Cancel</button>
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
  <div id="chartPanel" class="chart-panel" hidden>
    <div class="chart-toolbar">
      <label class="chart-field"><span>Chart type</span><select id="chartType" aria-label="Chart type">
        <option value="line">Line</option>
        <option value="scatter">Scatter</option>
        <option value="step">Step</option>
        <option value="bar">Bar</option>
        <option value="box">Box</option>
        <option value="candlestick">Candlestick</option>
      </select></label>
      <label class="chart-field"><span>X</span><select id="chartXColumn" disabled></select></label>
      <label id="chartGroupField" class="chart-field"><span>Group by</span><select id="chartGroupColumn" aria-label="Group by column" disabled>
        <option value="">None</option>
      </select></label>
      <div id="chartYColumns" class="chart-y-list" role="group" aria-label="Y columns"></div>
      <div id="chartOhlcColumns" class="chart-ohlc-fields" role="group" aria-label="Candlestick OHLC columns" hidden>
        <label class="chart-field"><span>Open</span><select id="chartOpenColumn" aria-label="Open column" disabled></select></label>
        <label class="chart-field"><span>High</span><select id="chartHighColumn" aria-label="High column" disabled></select></label>
        <label class="chart-field"><span>Low</span><select id="chartLowColumn" aria-label="Low column" disabled></select></label>
        <label class="chart-field"><span>Close</span><select id="chartCloseColumn" aria-label="Close column" disabled></select></label>
      </div>
      <button id="renderChart" disabled>Render</button>
      <button id="exportChart" hidden disabled>Export PNG</button>
      <button id="resetChartZoom" disabled>Reset zoom</button>
      <button id="refineChartZoom" disabled>Refine zoom</button>
      <button id="closeChart">Close</button>
      <span id="chartStatus" class="status"></span>
    </div>
    <div id="chartCanvasWrap" class="chart-canvas-wrap">
      <div id="chartPlot" class="chart-plot"></div>
      <div id="chartTooltip" class="chart-tooltip" hidden></div>
    </div>
    <div id="chartLegend" class="chart-legend"></div>
  </div>
  <div id="chartSplitter" class="chart-splitter" role="separator" aria-orientation="horizontal" aria-label="Resize chart and table" title="Drag to resize chart and table" hidden></div>
  <div id="viewport" tabindex="0" data-vscode-context='{"webviewSection":"kdbResultsTable","preventDefaultContextMenuItems":true}'>
    <div id="canvas">
      <div id="header" class="header" role="row"></div>
      <div id="rows"></div>
      <div id="empty" class="empty" hidden>0 rows</div>
    </div>
  </div>
  <div id="textViewport" class="text-viewport" tabindex="0" hidden>
    <pre id="textViewer" class="text-viewer"></pre>
  </div>
  <script nonce="${nonce}" src="${uplotScriptUri}"></script>
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
        copyExportConfirmCellThreshold: 1000000,
        localDataServerFullExportCellLimit: 1000000,
        elapsedTimeDisplay: 'auto',
        chartDecimalPlaces: 4,
        chartZoomMinSampledPoints: ${CHART_ZOOM_MIN_SAMPLED_POINTS},
        chartZoomMaxSampledPoints: ${CHART_ZOOM_MAX_SAMPLED_POINTS},
        arrayDisplayFormat: 'commaSpace',
        functionDisplayStrategy: 'qText',
        dictionaryDisplayStrategy: 'grid',
        listDisplayStrategy: 'grid',
        objectDisplayStrategy: 'grid'
      };
      const viewport = document.getElementById('viewport');
      const textViewport = document.getElementById('textViewport');
      const textViewer = document.getElementById('textViewer');
      const canvas = document.getElementById('canvas');
      const header = document.getElementById('header');
      const rowsLayer = document.getElementById('rows');
      const actionFormat = document.getElementById('actionFormat');
      const copyButton = document.getElementById('copy');
      const exportButton = document.getElementById('export');
      const includeHeadersLabel = document.getElementById('includeHeadersLabel');
      const includeRowIndexLabel = document.getElementById('includeRowIndexLabel');
      const includeRowIndex = document.getElementById('includeRowIndex');
      const includeHeaders = document.getElementById('includeHeaders');
      const autoFit = document.getElementById('autoFit');
      const interactionMode = document.getElementById('interactionMode');
      const sortStatus = document.getElementById('sortStatus');
      const searchInput = document.getElementById('searchInput');
      const searchPrev = document.getElementById('searchPrev');
      const searchNext = document.getElementById('searchNext');
      const searchStatus = document.getElementById('searchStatus');
      const settingsMenu = document.getElementById('settingsMenu');
      const expandSettingsSections = document.getElementById('expandSettingsSections');
      const collapseSettingsSections = document.getElementById('collapseSettingsSections');
      const settingsShowRowIndex = document.getElementById('settingsShowRowIndex');
      const settingsIncludeHeaders = document.getElementById('settingsIncludeHeaders');
      const settingsIncludeRowIndex = document.getElementById('settingsIncludeRowIndex');
      const settingsHideLargeResultWarnings = document.getElementById('settingsHideLargeResultWarnings');
      const settingsHideLargeSortWarnings = document.getElementById('settingsHideLargeSortWarnings');
      const settingsCopyExportConfirmCellThreshold = document.getElementById('settingsCopyExportConfirmCellThreshold');
      const settingsLocalDataServerFullExportCellLimit = document.getElementById('settingsLocalDataServerFullExportCellLimit');
      const settingsChartDecimalPlaces = document.getElementById('settingsChartDecimalPlaces');
      const settingsElapsedTimeDisplay = document.getElementById('settingsElapsedTimeDisplay');
      const settingsArrayDisplayFormat = document.getElementById('settingsArrayDisplayFormat');
      const settingsFunctionDisplayStrategy = document.getElementById('settingsFunctionDisplayStrategy');
      const settingsDictionaryDisplayStrategy = document.getElementById('settingsDictionaryDisplayStrategy');
      const settingsListDisplayStrategy = document.getElementById('settingsListDisplayStrategy');
      const settingsObjectDisplayStrategy = document.getElementById('settingsObjectDisplayStrategy');
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
      const startLocalDataServer = document.getElementById('startLocalDataServer');
      const stopLocalDataServer = document.getElementById('stopLocalDataServer');
      const copyCurrentCsvUrl = document.getElementById('copyCurrentCsvUrl');
      const copyMetadataUrl = document.getElementById('copyMetadataUrl');
      const localDataServerStatus = document.getElementById('localDataServerStatus');
      const localDataServerBadge = document.getElementById('localDataServerBadge');
      const localDataServerBaseUrl = document.getElementById('localDataServerBaseUrl');
      const openChart = document.getElementById('openChart');
      const spinner = document.getElementById('spinner');
      const cancelQuery = document.getElementById('cancelQuery');
      const summary = document.getElementById('summary');
      const largeResultWarning = document.getElementById('largeResultWarning');
      const largeResultSummary = document.getElementById('largeResultSummary');
      const largeResultWarningText = document.getElementById('largeResultWarningText');
      const hideLargeOnce = document.getElementById('hideLargeOnce');
      const hideLargeForever = document.getElementById('hideLargeForever');
      const status = document.getElementById('status');
      const selectionLabel = document.getElementById('selection');
      const message = document.getElementById('message');
      const chartPanel = document.getElementById('chartPanel');
      const chartType = document.getElementById('chartType');
      const chartXColumn = document.getElementById('chartXColumn');
      const chartGroupField = document.getElementById('chartGroupField');
      const chartGroupColumn = document.getElementById('chartGroupColumn');
      const chartYColumns = document.getElementById('chartYColumns');
      const chartOhlcColumns = document.getElementById('chartOhlcColumns');
      const chartOpenColumn = document.getElementById('chartOpenColumn');
      const chartHighColumn = document.getElementById('chartHighColumn');
      const chartLowColumn = document.getElementById('chartLowColumn');
      const chartCloseColumn = document.getElementById('chartCloseColumn');
      const renderChart = document.getElementById('renderChart');
      const exportChart = document.getElementById('exportChart');
      const resetChartZoomButton = document.getElementById('resetChartZoom');
      const refineChartZoomButton = document.getElementById('refineChartZoom');
      const closeChart = document.getElementById('closeChart');
      const chartStatus = document.getElementById('chartStatus');
      const chartCanvasWrap = document.getElementById('chartCanvasWrap');
      const chartPlot = document.getElementById('chartPlot');
      const chartTooltip = document.getElementById('chartTooltip');
      const chartLegend = document.getElementById('chartLegend');
      const chartSplitter = document.getElementById('chartSplitter');
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
      let autoFitEnabled = true;
      let columnDragState = null;
      let localDataServer = null;
      let latestChartRequestId = 0;
      let chartOptionsRequestId = 0;
      let chartOptions = { xColumns: [], yColumns: [], groupColumns: [], warnings: [] };
      let chartData = null;
      let chartRendered = null;
      let chartUPlot = null;
      let chartZoomed = false;
      let chartFullXRange = null;
      let chartRequestIsRefinement = false;
      let chartZoomStateSuspended = false;
      let chartControlsDirty = false;
      let chartResizeState = null;
      let chartHeight = 280;
      let chartAutoRenderPending = false;
      let chartAutoRefineTimer = 0;
      let chartLastAutoRefineKey = '';
      const CHART_PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
      const CHART_MIN_HEIGHT = 180;
      const CHART_MAX_HEIGHT = 720;
      const CHART_AUTO_REFINE_DELAY_MS = 450;
      ${chartRangeIsZoomed.toString()}
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
        } else if (msg.type === 'textCopied' && isCurrentVersionMessage(msg)) {
          status.textContent = 'Copied text';
        } else if (msg.type === 'textExported' && isCurrentVersionMessage(msg)) {
          status.textContent = 'Exported text';
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
        } else if (msg.type === 'localDataServerStatus') {
          setLocalDataServerStatus(msg.server || null, String(msg.message || ''));
        } else if (msg.type === 'localDataServerMessage') {
          setLocalDataServerStatus(localDataServer, String(msg.message || ''));
        } else if (msg.type === 'chartOptions' && isCurrentVersionMessage(msg)) {
          setChartOptions(msg);
        } else if (msg.type === 'chartData' && msg.data) {
          setChartData(msg.data);
        } else if (msg.type === 'chartError' && isCurrentVersionMessage(msg)) {
          setChartError(msg);
        } else if (msg.type === 'chartExported' && isCurrentChartMessage(msg)) {
          chartStatus.textContent = String(msg.message || 'Chart exported / saved.');
          status.textContent = 'Chart exported / saved.';
        } else if (msg.type === 'chartExportSkipped' && isCurrentChartMessage(msg)) {
          chartStatus.textContent = String(msg.message || 'Chart export canceled.');
        } else if (msg.type === 'chartExportError' && isCurrentChartMessage(msg)) {
          chartStatus.textContent = String(msg.message || 'Chart export failed.');
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
      settingsCopyExportConfirmCellThreshold.addEventListener('change', () => updatePositiveIntegerSetting('copyExportConfirmCellThreshold', settingsCopyExportConfirmCellThreshold));
      settingsLocalDataServerFullExportCellLimit.addEventListener('change', () => updatePositiveIntegerSetting('localDataServerFullExportCellLimit', settingsLocalDataServerFullExportCellLimit));
      settingsChartDecimalPlaces.addEventListener('change', () => updateNumberSetting('chartDecimalPlaces', settingsChartDecimalPlaces, 0, 12));
      expandSettingsSections.addEventListener('click', () => setSettingsSectionsOpen(true));
      collapseSettingsSections.addEventListener('click', () => setSettingsSectionsOpen(false));
      settingsElapsedTimeDisplay.addEventListener('change', () => updateSetting('elapsedTimeDisplay', String(settingsElapsedTimeDisplay.value || 'auto')));
      settingsArrayDisplayFormat.addEventListener('change', () => updateSetting('arrayDisplayFormat', normalizeArrayDisplayFormat(settingsArrayDisplayFormat.value)));
      settingsFunctionDisplayStrategy.addEventListener('change', () => updateSetting('functionDisplayStrategy', normalizeQResultDisplayStrategy(settingsFunctionDisplayStrategy.value, 'qText')));
      settingsDictionaryDisplayStrategy.addEventListener('change', () => updateSetting('dictionaryDisplayStrategy', normalizeQResultDisplayStrategy(settingsDictionaryDisplayStrategy.value, 'grid')));
      settingsListDisplayStrategy.addEventListener('change', () => updateSetting('listDisplayStrategy', normalizeQResultDisplayStrategy(settingsListDisplayStrategy.value, 'grid')));
      settingsObjectDisplayStrategy.addEventListener('change', () => updateSetting('objectDisplayStrategy', normalizeQResultDisplayStrategy(settingsObjectDisplayStrategy.value, 'grid')));
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
      startLocalDataServer.addEventListener('click', () => vscode.postMessage({ type: 'startLocalDataServer' }));
      stopLocalDataServer.addEventListener('click', () => vscode.postMessage({ type: 'stopLocalDataServer' }));
      copyCurrentCsvUrl.addEventListener('click', () => vscode.postMessage({ type: 'copyLocalDataServerUrl', endpoint: 'current.csv' }));
      copyMetadataUrl.addEventListener('click', () => vscode.postMessage({ type: 'copyLocalDataServerUrl', endpoint: 'metadata.json' }));
      cancelQuery.addEventListener('click', () => {
        cancelQuery.disabled = true;
        status.textContent = 'Canceling query...';
        vscode.postMessage({ type: 'cancelRunningQuery', version: data.version });
      });
      openChart.addEventListener('click', openChartPanel);
      chartType.addEventListener('change', onChartTypeChanged);
      chartXColumn.addEventListener('change', onChartControlChanged);
      chartGroupColumn.addEventListener('change', onChartControlChanged);
      chartOpenColumn.addEventListener('change', onChartControlChanged);
      chartHighColumn.addEventListener('change', onChartControlChanged);
      chartLowColumn.addEventListener('change', onChartControlChanged);
      chartCloseColumn.addEventListener('change', onChartControlChanged);
      renderChart.addEventListener('click', requestChartData);
      exportChart.addEventListener('click', exportChartPng);
      resetChartZoomButton.addEventListener('click', resetChartZoom);
      refineChartZoomButton.addEventListener('click', refineChartZoom);
      closeChart.addEventListener('click', closeChartPanel);
      chartCanvasWrap.addEventListener('mouseleave', hideChartTooltip);
      chartSplitter.addEventListener('mousedown', startChartResize);
      viewport.addEventListener('scroll', requestRender);
      viewport.addEventListener('contextmenu', () => {
        vscode.postMessage({ type: 'tableContextMenu' });
      });
      document.addEventListener('click', event => {
        const target = event.target;
        if (settingsMenu.open && !settingsMenu.contains(target)) {
          settingsMenu.open = false;
        }
        if (largeResultWarning.open && !largeResultWarning.contains(target)) {
          largeResultWarning.open = false;
        }
      });
      window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && closeToolbarMenus(true)) {
          event.preventDefault();
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && hasTableCells()) {
          event.preventDefault();
          copySelection();
        }
      });
      window.addEventListener('mousemove', event => {
        if (chartResizeState) {
          setChartHeight(chartResizeState.startHeight + event.clientY - chartResizeState.startY);
          event.preventDefault();
          return;
        }
        if (!resizeState) {
          return;
        }
        const width = clampInteger(resizeState.startWidth + event.clientX - resizeState.startX, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
        setColumnWidthOverride(resizeState.column, width);
        event.preventDefault();
      });
      window.addEventListener('mouseup', () => {
        if (chartResizeState) {
          chartResizeState = null;
          chartSplitter.classList.remove('is-dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
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
      window.addEventListener('resize', () => {
        requestRender();
        if (!chartPanel.hidden) {
          setChartHeight(chartHeight);
        } else {
          drawChart();
        }
      });
      settingsMenu.addEventListener('toggle', () => {
        if (settingsMenu.open) {
          // Chart is a direct button, not a dropdown.
        }
      });
      function closeToolbarMenus(restoreFocus) {
        let closed = false;
        let focusTarget = null;
        if (settingsMenu.open) {
          focusTarget = settingsMenu;
          settingsMenu.open = false;
          closed = true;
        }
        if (largeResultWarning.open) {
          focusTarget = largeResultWarning;
          largeResultWarning.open = false;
          closed = true;
        }
        if (closed && restoreFocus && focusTarget) {
          focusTarget.focus();
        }
        return closed;
      }

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
        cancelQuery.hidden = false;
        cancelQuery.disabled = false;
        setActionsDisabled(true);
        updateLocalDataServerControls();
        resetChartState('Run a query result before charting.');
        sendSelectionChanged();
        renderColumnSettings();
        showMessage('', false);
        updateLargeResultWarning();
        renderNow();
      }

      function setResultMeta(result) {
        applySettings(result.settings);
        const mode = result.mode === 'text' ? 'text' : 'table';
        const nextColumns = Array.isArray(result.columns) ? result.columns.map(String) : [];
        if (!sameColumnNames(columnWidthSchema, nextColumns)) {
          columnWidthOverrides = Object.create(null);
          autoColumnWidths = Object.create(null);
          columnWidthSchema = nextColumns.slice();
        }
        data = {
          version: toNonNegativeInteger(result.version, data.version + 1),
          mode,
          columns: nextColumns,
          allColumns: Array.isArray(result.allColumns) ? result.allColumns.map(String) : [],
          hiddenColumnNames: Array.isArray(result.hiddenColumnNames) ? result.hiddenColumnNames.map(String) : [],
          hiddenColumnCount: toNonNegativeInteger(result.hiddenColumnCount, 0),
          rowCount: toNonNegativeInteger(result.rowCount, 0),
          text: mode === 'text' ? String(result.text || '') : '',
          messages: Array.isArray(result.messages) ? result.messages.map(String) : [],
          guardrailMessage: result.guardrailMessage ? String(result.guardrailMessage) : '',
          query: result.query || '',
          connectionName: result.connectionName || '',
          elapsedMs: toNonNegativeInteger(result.elapsedMs, 0),
          error: !!result.error,
          canceled: !!result.canceled,
          sort: normalizeSortState(result.sort),
          hasResult: true
        };
        if (data.allColumns.length === 0) {
          data.allColumns = data.columns.slice();
        }
        applySettings(settings);
        resetWindowState();
        chartAutoRenderPending = result.chartAutoOpen === true;
        updateSummary();
        status.textContent = '';
        updateSortStatus();
        resetSearch(false);
        spinner.hidden = true;
        cancelQuery.hidden = true;
        cancelQuery.disabled = true;
        updateActionState();
        updateLocalDataServerControls();
        resetChartState('');
        sendSelectionChanged();
        updateSelectionLabel();
        renderColumnSettings();
        showMessage(resultMessageText(data), data.error);
        updateLargeResultWarning();
        renderNow();
        if (chartAutoRenderPending && hasTableCells() && !data.error && !data.canceled) {
          openChartPanel();
        }
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

      function isCurrentChartMessage(msg) {
        return isCurrentVersionMessage(msg) && toNonNegativeInteger(msg.requestId, -1) === latestChartRequestId;
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
        const textMode = isTextResult();
        actionFormat.disabled = disabled || textMode;
        copyButton.disabled = disabled || (!textMode && String(actionFormat.value || '') === 'xlsx');
        copyButton.title = textMode
          ? 'Copy text output'
          : (String(actionFormat.value || '') === 'xlsx' ? 'XLSX is export-only' : '');
        exportButton.disabled = disabled;
        exportButton.title = textMode ? 'Export text output as .txt' : '';
        includeHeadersLabel.hidden = textMode;
        includeRowIndexLabel.hidden = textMode;
        includeHeaders.disabled = textMode;
        includeRowIndex.disabled = textMode;
      }

      function updateActionState() {
        setActionsDisabled(!hasActionContent());
        updateLocalDataServerControls();
        updateChartControls();
      }

      function isTextResult() {
        return data.mode === 'text';
      }

      function hasActionContent() {
        return hasTableCells() || (data.hasResult && isTextResult() && !data.error && !data.canceled);
      }

      function hasTableCells() {
        return !isTextResult() && data.rowCount > 0 && data.columns.length > 0;
      }

      function setLocalDataServerStatus(server, message) {
        localDataServer = server;
        updateLocalDataServerControls();
        const runningLabel = server ? server.host + ':' + server.port : '';
        localDataServerStatus.textContent = message || (server ? 'Server running on ' + runningLabel : 'Server stopped');
        localDataServerBadge.textContent = server ? runningLabel : 'Stopped';
        localDataServerBadge.classList.toggle('is-running', !!server);
        localDataServerBaseUrl.hidden = !server;
        localDataServerBaseUrl.textContent = server ? 'Base URL: ' + String(server.baseUrl || '') : '';
      }

      function updateLocalDataServerControls() {
        const hasResult = data.hasResult && !isTextResult() && !data.error && !data.canceled && data.rowCount >= 0;
        const running = !!localDataServer;
        startLocalDataServer.disabled = !hasResult || running;
        stopLocalDataServer.disabled = !running;
        copyCurrentCsvUrl.disabled = !running || !hasResult;
        copyMetadataUrl.disabled = !running || !hasResult;
      }

      function startChartResize(event) {
        if (chartPanel.hidden) {
          return;
        }
        chartResizeState = {
          startY: event.clientY,
          startHeight: chartHeight
        };
        chartSplitter.classList.add('is-dragging');
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        event.preventDefault();
      }

      function setChartHeight(value) {
        const availableHeight = Math.max(CHART_MIN_HEIGHT, window.innerHeight - 170);
        const maxHeight = Math.min(CHART_MAX_HEIGHT, availableHeight);
        chartHeight = clampInteger(value, CHART_MIN_HEIGHT, Math.max(CHART_MIN_HEIGHT, maxHeight));
        chartPanel.style.setProperty('--chart-height', chartHeight + 'px');
        chartSplitter.setAttribute('aria-valuenow', String(chartHeight));
        chartSplitter.setAttribute('aria-valuemin', String(CHART_MIN_HEIGHT));
        chartSplitter.setAttribute('aria-valuemax', String(Math.max(CHART_MIN_HEIGHT, maxHeight)));
        drawChart();
        requestRender();
      }

      function updateChartControls() {
        openChart.disabled = !hasTableCells() || !!data.error || !!data.canceled;
        renderChart.disabled = !chartCanRender();
        const canExport = chartCanExport();
        exportChart.hidden = !canExport;
        exportChart.disabled = !canExport;
        resetChartZoomButton.disabled = !canExport || !chartZoomed;
        refineChartZoomButton.disabled = !chartCanRefineZoom();
        openChart.textContent = chartPanel.hidden ? 'Chart' : (chartControlsDirty ? 'Chart*' : 'Chart');
        openChart.title = chartPanel.hidden ? 'Open chart' : (chartControlsDirty ? 'Chart settings changed — Render to update' : 'Chart open');
        chartSplitter.hidden = chartPanel.hidden;
      }

      function openChartPanel() {
        if (!hasTableCells() || data.error || data.canceled) {
          return;
        }
        chartPanel.hidden = false;
        chartSplitter.hidden = false;
        notifyChartPanelState(false);
        setChartHeight(chartHeight);
        settingsMenu.open = false;
        chartStatus.textContent = 'Detecting chart columns...';
        chartControlsDirty = false;
        if (!chartRendered || chartRendered.version !== data.version) {
          chartData = null;
          chartRendered = null;
          destroyChartPlot();
          chartLegend.textContent = '';
          hideChartTooltip();
        }
        requestChartOptions();
        updateChartControls();
        drawChart();
      }

      function closeChartPanel() {
        chartPanel.hidden = true;
        chartSplitter.hidden = true;
        latestChartRequestId += 1;
        chartRequestIsRefinement = false;
        clearChartZoomBaseline();
        chartData = null;
        chartRendered = null;
        chartControlsDirty = false;
        destroyChartPlot();
        hideChartTooltip();
        chartStatus.textContent = '';
        chartLegend.textContent = '';
        chartAutoRenderPending = false;
        clearChartAutoRefineTimer();
        notifyChartPanelState(false);
        updateChartControls();
      }

      function resetChartState(messageText) {
        latestChartRequestId += 1;
        chartOptionsRequestId += 1;
        chartRequestIsRefinement = false;
        clearChartZoomBaseline();
        chartOptions = { xColumns: [], yColumns: [], groupColumns: [], warnings: [] };
        chartData = null;
        chartRendered = null;
        chartControlsDirty = false;
        chartAutoRenderPending = false;
        chartLastAutoRefineKey = '';
        clearChartAutoRefineTimer();
        destroyChartPlot();
        chartPanel.hidden = true;
        chartSplitter.hidden = true;
        chartXColumn.textContent = '';
        chartGroupColumn.textContent = '';
        chartYColumns.textContent = '';
        chartOpenColumn.textContent = '';
        chartHighColumn.textContent = '';
        chartLowColumn.textContent = '';
        chartCloseColumn.textContent = '';
        chartStatus.textContent = messageText || '';
        chartLegend.textContent = '';
        hideChartTooltip();
        updateChartControls();
      }

      function requestChartOptions() {
        if (chartPanel.hidden || !hasTableCells()) {
          return;
        }
        chartOptionsRequestId += 1;
        vscode.postMessage({
          type: 'requestChartOptions',
          version: data.version,
          requestId: chartOptionsRequestId
        });
      }

      function setChartOptions(msg) {
        const requestId = toInteger(msg.requestId, 0);
        if (requestId < chartOptionsRequestId) {
          return;
        }
        chartOptions = normalizeChartOptions(msg.options || {});
        renderChartOptions();
        const restored = applySavedChartSelection(msg.savedSelection);
        const shouldAutoRender = msg.autoChart === true || chartAutoRenderPending;
        chartAutoRenderPending = false;
        if (restored) {
          chartStatus.textContent = shouldAutoRender ? 'Rendering restored chart settings...' : 'Restored chart settings for these columns.';
        }
        if (shouldAutoRender && chartCanRender()) {
          requestChartDataForRange(null, restored ? 'Rendering restored chart settings...' : 'Rendering chart...');
          return;
        }
        updateChartControls();
      }

      function normalizeChartOptions(value) {
        return {
          xColumns: normalizeChartColumnOptions(value.xColumns),
          yColumns: normalizeChartColumnOptions(value.yColumns),
          groupColumns: normalizeChartGroupColumnOptions(value.groupColumns),
          warnings: Array.isArray(value.warnings) ? value.warnings.map(String) : []
        };
      }

      function normalizeChartColumnOptions(values) {
        if (!Array.isArray(values)) {
          return [];
        }
        return values
          .map(option => {
            return {
              columnName: String(option && option.columnName || ''),
              columnIndex: toInteger(option && option.columnIndex, -1),
              kind: option && option.kind === 'temporal' ? 'temporal' : 'numeric'
            };
          })
          .filter(option => option.columnName && option.columnIndex >= 0);
      }

      function normalizeChartGroupColumnOptions(values) {
        if (!Array.isArray(values)) {
          return [];
        }
        return values
          .map(option => {
            return {
              columnName: String(option && option.columnName || ''),
              columnIndex: toInteger(option && option.columnIndex, -1),
              kind: 'categorical'
            };
          })
          .filter(option => option.columnName && option.columnIndex >= 0);
      }

      function renderChartOptions() {
        chartRequestIsRefinement = false;
        clearChartZoomBaseline();
        chartXColumn.textContent = '';
        chartGroupColumn.textContent = '';
        chartYColumns.textContent = '';
        chartOpenColumn.textContent = '';
        chartHighColumn.textContent = '';
        chartLowColumn.textContent = '';
        chartCloseColumn.textContent = '';
        chartXColumn.disabled = chartOptions.xColumns.length === 0;
        chartOptions.xColumns.forEach(option => {
          const element = document.createElement('option');
          element.value = option.columnName;
          element.textContent = option.columnName + ' (' + option.kind + ')';
          chartXColumn.appendChild(element);
        });
        const preferredX = chartOptions.xColumns.find(option => option.kind === 'temporal') || chartOptions.xColumns[0];
        if (preferredX) {
          chartXColumn.value = preferredX.columnName;
        }

        const noGroup = document.createElement('option');
        noGroup.value = '';
        noGroup.textContent = 'None';
        chartGroupColumn.appendChild(noGroup);
        chartOptions.groupColumns.forEach(option => {
          const element = document.createElement('option');
          element.value = option.columnName;
          element.textContent = option.columnName;
          chartGroupColumn.appendChild(element);
        });
        chartGroupColumn.disabled = chartOptions.groupColumns.length === 0;

        const defaultY = defaultChartYColumns();
        chartOptions.yColumns.forEach(option => {
          const label = document.createElement('label');
          label.className = 'checkbox';
          label.title = option.columnName;
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = option.columnName;
          checkbox.checked = defaultY.indexOf(option.columnName) !== -1;
          checkbox.addEventListener('change', onChartControlChanged);
          const text = document.createElement('span');
          text.textContent = option.columnName;
          label.appendChild(checkbox);
          label.appendChild(text);
          chartYColumns.appendChild(label);
        });

        populateCandlestickColumnSelect(chartOpenColumn, 'Open');
        populateCandlestickColumnSelect(chartHighColumn, 'High');
        populateCandlestickColumnSelect(chartLowColumn, 'Low');
        populateCandlestickColumnSelect(chartCloseColumn, 'Close');
        chartOpenColumn.value = defaultCandlestickColumn('open');
        chartHighColumn.value = defaultCandlestickColumn('high');
        chartLowColumn.value = defaultCandlestickColumn('low');
        chartCloseColumn.value = defaultCandlestickColumn('close');
        updateChartTypeControls();

        const warnings = chartOptions.warnings.length > 0 ? ' ' + chartOptions.warnings.join(' ') : '';
        if (chartOptions.xColumns.length === 0 || chartOptions.yColumns.length === 0) {
          chartStatus.textContent = 'No eligible chart columns.' + warnings;
        } else {
          chartStatus.textContent = chartControlStatusMessage() + warnings;
        }
        chartControlsDirty = false;
        updateChartControls();
      }

      function populateCandlestickColumnSelect(select, role) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select ' + role;
        select.appendChild(placeholder);
        chartOptions.yColumns.forEach(option => {
          const element = document.createElement('option');
          element.value = option.columnName;
          element.textContent = option.columnName;
          select.appendChild(element);
        });
      }

      function defaultCandlestickColumn(role) {
        const expected = String(role || '').trim().toLowerCase();
        const matches = chartOptions.yColumns.filter(option => {
          return String(option.columnName || '').trim().toLowerCase() === expected;
        });
        return matches.length === 1 ? matches[0].columnName : '';
      }

      function applySavedChartSelection(value) {
        if (!value || typeof value !== 'object') {
          return false;
        }
        const type = normalizeChartType(value.chartType);
        const xColumn = String(value.xColumn || '');
        if (!chartOptions.xColumns.some(option => option.columnName === xColumn)) {
          return false;
        }
        const yLookup = columnNameLookup(chartOptions.yColumns.map(option => option.columnName));
        let roles = null;
        let retainedY = [];
        if (type === 'candlestick') {
          roles = [
            String(value.openColumn || ''),
            String(value.highColumn || ''),
            String(value.lowColumn || ''),
            String(value.closeColumn || '')
          ];
          if (roles.some(column => !column || !yLookup[column]) || new Set(roles).size !== roles.length) {
            return false;
          }
        } else {
          const yColumns = Array.isArray(value.yColumns) ? value.yColumns.map(String).filter(Boolean) : [];
          retainedY = yColumns.filter(column => yLookup[column]);
          if (retainedY.length === 0) {
            return false;
          }
        }

        chartType.value = type;
        chartXColumn.value = xColumn;
        if (roles) {
          chartOpenColumn.value = roles[0];
          chartHighColumn.value = roles[1];
          chartLowColumn.value = roles[2];
          chartCloseColumn.value = roles[3];
        } else {
          chartYColumns.querySelectorAll('input[type="checkbox"]').forEach(input => {
            input.checked = retainedY.indexOf(String(input.value || '')) !== -1;
          });
        }

        const groupByColumn = chartTypeSupportsGroup(type) ? String(value.groupByColumn || '') : '';
        const hasGroup = groupByColumn && chartOptions.groupColumns.some(option => option.columnName === groupByColumn);
        chartGroupColumn.value = hasGroup ? groupByColumn : '';
        updateChartTypeControls();
        chartControlsDirty = false;
        updateChartControls();
        return true;
      }

      function defaultChartYColumns() {
        const x = String(chartXColumn.value || '');
        const names = chartOptions.yColumns
          .map(option => option.columnName)
          .filter(column => column !== x);
        return (names.length > 0 ? names : chartOptions.yColumns.map(option => option.columnName)).slice(0, 2);
      }

      function chartCanRender() {
        const baseReady = !chartPanel.hidden &&
          hasTableCells() &&
          chartOptions.xColumns.length > 0 &&
          String(chartXColumn.value || '').length > 0;
        if (!baseReady) {
          return false;
        }
        return selectedChartType() === 'candlestick'
          ? !candlestickControlValidationMessage()
          : selectedChartYColumns().length > 0;
      }

      function chartCanExport() {
        return !chartPanel.hidden &&
          !!chartRendered &&
          chartRendered.version === data.version &&
          chartRendered.requestId === latestChartRequestId &&
          !!renderedChartCanvas();
      }

      function chartCanRefineZoom() {
        return chartCanExport() && chartZoomed && !chartControlsDirty && !!currentChartZoomRange();
      }

      function chartControlStatusMessage() {
        const type = selectedChartType();
        if (!String(chartXColumn.value || '')) {
          return 'Select one numeric or temporal X column.';
        }
        if (type === 'candlestick') {
          const validation = candlestickControlValidationMessage();
          if (validation) {
            return validation + ' Group by is unavailable for candlesticks.';
          }
          return 'Candlestick uses distinct numeric Open, High, Low, Close columns; Group by is unavailable. ' +
            (chartRendered ? 'Render to apply changed settings.' : 'Press Render to create chart.');
        }
        if (selectedChartYColumns().length === 0) {
          return 'Select one x column and at least one numeric y column.';
        }
        const note = type === 'box' ? 'Box charts use numeric Y columns; Group by is unavailable. ' : '';
        return note + (chartRendered ? 'Chart settings changed — Render to update.' : 'Press Render to create chart.');
      }

      function candlestickControlValidationMessage() {
        const roles = selectedCandlestickColumns();
        const entries = [
          ['Open', roles.open],
          ['High', roles.high],
          ['Low', roles.low],
          ['Close', roles.close]
        ];
        const missing = entries.filter(entry => !entry[1]).map(entry => entry[0]);
        if (missing.length > 0) {
          return 'Select numeric ' + missing.join(', ') + ' column' + (missing.length === 1 ? '' : 's') + '.';
        }
        const names = entries.map(entry => entry[1]);
        if (new Set(names).size !== names.length) {
          return 'Open, High, Low, and Close must use four distinct numeric columns.';
        }
        const numericLookup = columnNameLookup(chartOptions.yColumns.map(option => option.columnName));
        const invalid = entries.filter(entry => !numericLookup[entry[1]]).map(entry => entry[0]);
        if (invalid.length > 0) {
          return invalid.join(', ') + ' must select numeric columns available in this result.';
        }
        return '';
      }

      function updateChartTypeControls() {
        const type = selectedChartType();
        const candlestick = type === 'candlestick';
        const supportsGroup = chartTypeSupportsGroup(type);
        chartGroupField.hidden = !supportsGroup;
        chartGroupColumn.disabled = !supportsGroup || chartOptions.groupColumns.length === 0;
        if (!supportsGroup) {
          chartGroupColumn.value = '';
        }
        chartYColumns.hidden = candlestick;
        chartYColumns.querySelectorAll('input[type="checkbox"]').forEach(input => {
          input.disabled = candlestick;
        });
        chartOhlcColumns.hidden = !candlestick;
        [chartOpenColumn, chartHighColumn, chartLowColumn, chartCloseColumn].forEach(select => {
          select.disabled = !candlestick || chartOptions.yColumns.length === 0;
        });
      }

      function chartTypeSupportsGroup(type) {
        return type === 'line' || type === 'scatter' || type === 'step' || type === 'bar';
      }

      function onChartTypeChanged() {
        updateChartTypeControls();
        onChartControlChanged();
      }

      function onChartControlChanged() {
        chartRequestIsRefinement = false;
        clearChartZoomBaseline();
        chartControlsDirty = true;
        hideChartTooltip();
        chartStatus.textContent = chartControlStatusMessage();
        updateChartControls();
      }

      function clearChartRendered() {
        chartRendered = null;
        clearChartZoomBaseline();
        updateChartControls();
      }

      function clearChartZoomBaseline() {
        chartFullXRange = null;
        chartZoomed = false;
        chartLastAutoRefineKey = '';
        clearChartAutoRefineTimer();
      }

      function selectedChartYColumns() {
        if (selectedChartType() === 'candlestick') {
          return [];
        }
        const values = [];
        chartYColumns.querySelectorAll('input[type="checkbox"]').forEach(input => {
          if (input.checked) {
            values.push(String(input.value || ''));
          }
        });
        return values.filter(Boolean);
      }

      function selectedChartGroupColumn() {
        return chartTypeSupportsGroup(selectedChartType()) ? String(chartGroupColumn.value || '') : '';
      }

      function selectedCandlestickColumns() {
        return {
          open: String(chartOpenColumn.value || ''),
          high: String(chartHighColumn.value || ''),
          low: String(chartLowColumn.value || ''),
          close: String(chartCloseColumn.value || '')
        };
      }

      function selectedChartType() {
        return normalizeChartType(chartType.value);
      }

      function normalizeChartType(value) {
        const text = String(value || '').toLowerCase();
        return text === 'scatter' || text === 'step' || text === 'bar' || text === 'box' || text === 'candlestick'
          ? text
          : 'line';
      }

      function requestChartData() {
        requestChartDataForRange(null, 'Sampling chart data...');
      }

      function refineChartZoom() {
        if (chartControlsDirty) {
          chartStatus.textContent = 'Render changed chart settings before refining zoom.';
          updateChartControls();
          return;
        }
        const range = currentChartZoomRange();
        if (!range) {
          chartStatus.textContent = 'Zoom the chart before refining.';
          updateChartControls();
          return;
        }
        requestChartDataForRange(range, 'Refining chart to zoom range...');
      }

      function requestChartDataForRange(xRange, messageText) {
        if (!chartCanRender()) {
          chartStatus.textContent = chartControlStatusMessage();
          return;
        }
        chartRequestIsRefinement = !!xRange;
        if (!chartRequestIsRefinement) {
          clearChartZoomBaseline();
        }
        latestChartRequestId += 1;
        chartRendered = null;
        chartControlsDirty = false;
        clearChartAutoRefineTimer();
        chartLastAutoRefineKey = xRange ? chartZoomRangeKey(xRange) : '';
        updateChartControls();
        chartStatus.textContent = messageText;
        const message = {
          type: 'requestChart',
          version: data.version,
          requestId: latestChartRequestId,
          chartType: selectedChartType(),
          xColumn: String(chartXColumn.value || ''),
          yColumns: selectedChartYColumns(),
          groupByColumn: selectedChartGroupColumn(),
          openColumn: selectedCandlestickColumns().open,
          highColumn: selectedCandlestickColumns().high,
          lowColumn: selectedCandlestickColumns().low,
          closeColumn: selectedCandlestickColumns().close,
          width: Math.max(320, Math.floor(chartCanvasWrap.clientWidth || 800))
        };
        if (xRange) {
          message.xMin = xRange.min;
          message.xMax = xRange.max;
          message.minSampledPoints = chartZoomMinSampledPoints();
          message.maxSampledPoints = chartZoomMaxSampledPoints();
        }
        vscode.postMessage(message);
      }

      function exportChartPng() {
        if (!chartCanExport()) {
          chartStatus.textContent = 'Render a chart before exporting.';
          updateChartControls();
          return;
        }
        const canvas = renderedChartCanvas();
        if (!canvas || typeof canvas.toDataURL !== 'function') {
          chartStatus.textContent = 'Chart canvas is unavailable.';
          return;
        }

        const rendered = chartRendered;
        let dataUrl = '';
        try {
          dataUrl = canvas.toDataURL('image/png');
        } catch (error) {
          chartStatus.textContent = 'Chart export failed: canvas unavailable or blocked.';
          return;
        }

        if (typeof dataUrl !== 'string' || dataUrl.indexOf(CHART_PNG_DATA_URL_PREFIX) !== 0) {
          chartStatus.textContent = 'Chart export failed: invalid PNG data.';
          return;
        }
        if (!rendered || rendered.version !== data.version || rendered.requestId !== latestChartRequestId) {
          chartStatus.textContent = 'Render a chart before exporting.';
          updateChartControls();
          return;
        }

        chartStatus.textContent = 'Saving chart PNG...';
        vscode.postMessage({
          type: 'exportChartPng',
          version: rendered.version,
          requestId: rendered.requestId,
          dataUrl
        });
      }

      function setChartData(value) {
        if (toNonNegativeInteger(value.version, -1) !== data.version ||
          toNonNegativeInteger(value.requestId, -1) !== latestChartRequestId ||
          chartControlsDirty) {
          return;
        }
        const normalized = normalizeChartData(value);
        if (normalized.chartType === 'candlestick' && normalized.invalidCandlestickCount > 0) {
          chartStatus.textContent = 'Candlestick data contains ' + formatUiCount(normalized.invalidCandlestickCount) +
            ' invalid OHLC point' + (normalized.invalidCandlestickCount === 1 ? '' : 's') +
            '; check finite Open, High, Low, Close values and High/Low bounds.';
          chartData = null;
          chartRendered = null;
          chartControlsDirty = false;
          drawChart();
          return;
        }
        chartData = normalized;
        chartRendered = null;
        chartControlsDirty = false;
        const warnings = chartData.warnings.length > 0 ? ' ' + chartData.warnings.join(' ') : '';
        const grouped = chartData.groupByColumn ? ' grouped by ' + chartData.groupByColumn : '';
        chartStatus.textContent = chartData.chartType === 'candlestick'
          ? 'Showing ' + formatUiCount(chartData.candlesticks.length) +
            ' candles from ' + formatUiCount(chartData.eligibleRowCount) +
            ' eligible rows (' + chartData.algorithm + '). Group by is unavailable.' + warnings
          : chartData.chartType === 'box'
            ? 'Showing ' + formatUiCount(chartData.sampledPointCount) +
              ' box groups from ' + formatUiCount(chartData.eligibleRowCount) +
              ' eligible rows (' + chartData.algorithm + '). Group by is unavailable.' + warnings
            : 'Showing ' + formatUiCount(chartData.sampledPointCount) +
              ' of ' + formatUiCount(chartData.eligibleRowCount) +
              ' eligible rows' + grouped + ' (' + chartData.algorithm + ').' + warnings;
        drawChart();
      }

      function normalizeChartData(value) {
        const type = normalizeChartType(value.chartType);
        const normalizedCandlesticks = Array.isArray(value.candlesticks)
          ? value.candlesticks.map(normalizeCandlestick)
          : [];
        const invalidCandlestickCount = normalizedCandlesticks.filter(candle => !candle).length;
        const candlesticks = normalizedCandlesticks.filter(Boolean);
        const x = type === 'candlestick' && candlesticks.length > 0
          ? candlesticks.map(candle => candle.x)
          : (Array.isArray(value.x) ? value.x.filter(item => typeof item === 'number' && Number.isFinite(item)) : []);
        const xText = type === 'candlestick' && candlesticks.length > 0
          ? candlesticks.map(candle => candle.xText)
          : (Array.isArray(value.xText) ? value.xText.map(String) : []);
        const xDomain = normalizeChartXDomain(value.xDomain);
        return {
          version: toNonNegativeInteger(value.version, 0),
          requestId: toNonNegativeInteger(value.requestId, 0),
          chartType: type,
          xColumn: String(value.xColumn || ''),
          groupByColumn: chartTypeSupportsGroup(type) && value.groupByColumn ? String(value.groupByColumn) : '',
          xKind: value.xKind === 'temporal' ? 'temporal' : 'numeric',
          x,
          xText,
          xDomain,
          series: Array.isArray(value.series) ? value.series.map(series => {
            return {
              columnName: String(series && series.columnName || ''),
              sourceColumnName: String(series && series.sourceColumnName || ''),
              groupValue: String(series && series.groupValue || ''),
              values: Array.isArray(series && series.values)
                ? series.values.map(item => typeof item === 'number' && Number.isFinite(item) ? item : null)
                : [],
              gapFlags: Array.isArray(series && series.gapFlags)
                ? series.gapFlags.map(flag => flag === true)
                : []
            };
          }).filter(series => series.columnName) : [],
          boxSeries: Array.isArray(value.boxSeries) ? value.boxSeries.map(series => {
            return {
              columnName: String(series && series.columnName || ''),
              stats: Array.isArray(series && series.stats)
                ? series.stats.map(normalizeBoxStats)
                : []
            };
          }).filter(series => series.columnName) : [],
          ohlcColumns: normalizeOhlcColumns(value.ohlcColumns),
          candlesticks,
          invalidCandlestickCount,
          sourceRowCount: toNonNegativeInteger(value.sourceRowCount, 0),
          eligibleRowCount: toNonNegativeInteger(value.eligibleRowCount, 0),
          sampledPointCount: toNonNegativeInteger(value.sampledPointCount, 0),
          algorithm: String(value.algorithm || 'none'),
          sorted: value.sorted === true,
          warnings: Array.isArray(value.warnings) ? value.warnings.map(String) : []
        };
      }

      function normalizeOhlcColumns(value) {
        return {
          open: String(value && value.open || ''),
          high: String(value && value.high || ''),
          low: String(value && value.low || ''),
          close: String(value && value.close || '')
        };
      }

      function normalizeChartXDomain(value) {
        const min = value && value.min;
        const max = value && value.max;
        return typeof min === 'number' && Number.isFinite(min) &&
          typeof max === 'number' && Number.isFinite(max) && max >= min
          ? { min, max }
          : null;
      }

      function normalizeCandlestick(value) {
        if (!value || typeof value !== 'object') {
          return null;
        }
        const x = value.x;
        const open = value.open;
        const high = value.high;
        const low = value.low;
        const close = value.close;
        if (typeof x !== 'number' || !Number.isFinite(x) ||
          typeof open !== 'number' || !Number.isFinite(open) ||
          typeof high !== 'number' || !Number.isFinite(high) ||
          typeof low !== 'number' || !Number.isFinite(low) ||
          typeof close !== 'number' || !Number.isFinite(close) ||
          high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
          return null;
        }
        return {
          x,
          xText: String(value.xText || ''),
          open,
          high,
          low,
          close
        };
      }

      function normalizeBoxStats(value) {
        if (!value || typeof value !== 'object') {
          return null;
        }
        const count = toNonNegativeInteger(value.count, 0);
        const min = Number(value.min);
        const q1 = Number(value.q1);
        const median = Number(value.median);
        const q3 = Number(value.q3);
        const max = Number(value.max);
        if (count <= 0 ||
          !Number.isFinite(min) ||
          !Number.isFinite(q1) ||
          !Number.isFinite(median) ||
          !Number.isFinite(q3) ||
          !Number.isFinite(max)) {
          return null;
        }
        return { count, min, q1, median, q3, max };
      }

      function setChartError(msg) {
        if (toNonNegativeInteger(msg.requestId, -1) !== latestChartRequestId || chartControlsDirty) {
          return;
        }
        chartRequestIsRefinement = false;
        clearChartZoomBaseline();
        chartStatus.textContent = String(msg.message || 'Chart failed.');
        chartData = null;
        chartRendered = null;
        chartControlsDirty = false;
        chartLegend.textContent = '';
        clearChartAutoRefineTimer();
        notifyChartPanelState(false);
        drawChart();
      }

      function drawChart() {
        if (!chartPlot || chartPanel.hidden) {
          destroyChartPlot();
          clearChartRendered();
          return;
        }
        if (!chartData || chartData.x.length === 0 ||
          (chartData.chartType === 'candlestick'
            ? chartData.candlesticks.length === 0
            : chartData.series.length === 0)) {
          destroyChartPlot();
          clearChartRendered();
          return;
        }
        if (typeof window.uPlot !== 'function') {
          destroyChartPlot();
          chartStatus.textContent = 'Chart library failed to load.';
          clearChartRendered();
          return;
        }

        const dimensions = chartDimensions();
        if (chartUPlot && chartRendered &&
          chartRendered.version === chartData.version &&
          chartRendered.requestId === chartData.requestId) {
          chartUPlot.setSize(dimensions);
          if (typeof chartUPlot.syncRect === 'function') {
            chartUPlot.syncRect();
          }
          updateChartZoomState(chartUPlot);
          return;
        }

        chartZoomStateSuspended = true;
        destroyChartPlot();
        try {
          chartUPlot = new window.uPlot(chartUPlotOptions(dimensions), chartAlignedData(), chartPlot);
          chartRendered = { version: chartData.version, requestId: chartData.requestId };
          if (!chartRequestIsRefinement) {
            const renderedXRange = chartXScaleRange(chartUPlot);
            chartFullXRange = renderedXRange
              ? Object.freeze({ min: renderedXRange.min, max: renderedXRange.max })
              : null;
          }
          chartZoomStateSuspended = false;
          updateChartZoomState(chartUPlot);
          notifyChartRendered();
          updateChartControls();
        } catch (error) {
          chartZoomStateSuspended = false;
          destroyChartPlot();
          chartStatus.textContent = 'Chart render failed: ' + chartErrorMessage(error);
          clearChartRendered();
        }
      }

      function chartDimensions() {
        const rect = chartCanvasWrap.getBoundingClientRect();
        return {
          width: Math.max(320, Math.floor(rect.width || 0)),
          height: Math.max(180, Math.floor(rect.height || 0))
        };
      }

      function chartAlignedData() {
        if (chartData.chartType === 'candlestick') {
          return [
            chartData.candlesticks.map(candle => candle.x),
            chartData.candlesticks.map(candle => candle.close)
          ];
        }
        const aligned = [chartData.x.slice()];
        chartData.series.forEach(series => {
          const values = [];
          const hasGapFlags = Array.isArray(series.gapFlags) && series.gapFlags.length > 0;
          for (let index = 0; index < chartData.x.length; index++) {
            const value = series.values[index];
            values.push(Number.isFinite(value)
              ? value
              : (hasGapFlags ? (series.gapFlags[index] === true ? null : undefined) : null));
          }
          aligned.push(values);
        });
        return aligned;
      }

      function chartUPlotOptions(dimensions) {
        const colors = chartColors();
        const axisColor = cssColor('--vscode-descriptionForeground', '#888');
        const gridColor = cssColor('--vscode-panel-border', '#555');
        const type = chartData.chartType;
        const series = [{
          label: chartData.xColumn,
          value: (_self, _rawValue, _seriesIndex, index) => index === null || index === undefined ? '' : chartXLabel(index)
        }];
        if (type === 'candlestick') {
          const candleColors = chartCandlestickColors();
          series.push({
            label: 'OHLC',
            stroke: candleColors.up,
            width: 0,
            spanGaps: false,
            points: {
              show: false,
              width: 1,
              stroke: candleColors.up,
              fill: candleColors.hollow
            },
            value: (_self, _rawValue, _seriesIndex, valueIndex) => chartCandlestickValueLabel(valueIndex)
          });
        } else {
          chartData.series.forEach((item, index) => {
            const color = colors[index % colors.length];
            const config = {
              label: item.columnName,
              stroke: color,
              width: type === 'scatter' || type === 'bar' || type === 'box' ? 0 : 1.5,
              spanGaps: false,
              points: chartSeriesPoints(type, color),
              value: (_self, rawValue, _seriesIndex, valueIndex) => chartSeriesValueLabel(type, index, rawValue, valueIndex)
            };
            if (type === 'step') {
              const stepped = window.uPlot && window.uPlot.paths && window.uPlot.paths.stepped;
              if (typeof stepped !== 'function') {
                throw new Error('Step renderer is unavailable.');
              }
              config.paths = stepped({ align: 1 });
            } else if (type === 'bar') {
              config.fill = chartAlphaColor(color, 0.42);
            }
            series.push(config);
          });
        }

        return {
          width: dimensions.width,
          height: dimensions.height,
          ms: 1,
          series,
          scales: {
            x: {
              time: chartData.xKind === 'temporal',
              range: chartNeedsXPadding() ? (_self, min, max) => chartPaddedXRange(min, max) : undefined
            },
            y: {
              auto: true,
              range: chartNeedsYRange() ? (_self, min, max) => chartYScaleRange(min, max) : undefined
            }
          },
          axes: [
            {
              scale: 'x',
              stroke: axisColor,
              grid: { stroke: gridColor, width: 1 },
              ticks: { stroke: gridColor, width: 1 },
              values: (self, splits) => chartThinnedXAxisLabels(self, splits)
            },
            {
              scale: 'y',
              stroke: axisColor,
              grid: { stroke: gridColor, width: 1 },
              ticks: { stroke: gridColor, width: 1 },
              values: (_self, splits) => splits.map(value => formatChartNumber(value))
            }
          ],
          cursor: {
            show: true,
            x: true,
            y: true,
            points: { show: true, size: 6 },
            drag: { setScale: true, x: true, y: false, dist: 5 },
            hover: { skip: [null, undefined] },
            focus: { prox: 24 }
          },
          legend: {
            show: true,
            live: true,
            isolate: false,
            mount: (_self, element) => {
              chartLegend.textContent = '';
              chartLegend.appendChild(element);
            }
          },
          hooks: {
            draw: type === 'candlestick'
              ? [drawChartCandlesticks]
              : (type === 'bar' ? [drawChartBars] : (type === 'box' ? [drawChartBoxes] : [])),
            setCursor: [updateChartTooltipFromUPlot],
            setScale: [updateChartZoomState],
            setSeries: [() => updateChartControls()]
          }
        };
      }

      function chartSeriesPoints(type, color) {
        if (type !== 'scatter') {
          return { show: false };
        }
        return {
          show: true,
          size: 5,
          width: 1,
          stroke: color,
          fill: chartAlphaColor(color, 0.35)
        };
      }

      function chartSeriesValueLabel(type, seriesIndex, rawValue, valueIndex) {
        if (type === 'box') {
          const stats = chartBoxStatsAt(seriesIndex, valueIndex);
          return stats
            ? 'med ' + formatChartNumber(stats.median) + ', n=' + formatUiCount(stats.count)
            : 'null';
        }
        return Number.isFinite(rawValue) ? formatChartNumber(rawValue) : 'null';
      }

      function chartCandlestickValueLabel(valueIndex) {
        if (!chartData || valueIndex === null || valueIndex === undefined) {
          return '';
        }
        const candle = chartData.candlesticks[valueIndex];
        return candle
          ? 'O ' + formatChartNumber(candle.open) +
            ' H ' + formatChartNumber(candle.high) +
            ' L ' + formatChartNumber(candle.low) +
            ' C ' + formatChartNumber(candle.close)
          : '';
      }

      function drawChartBars(self) {
        if (!chartData || chartData.chartType !== 'bar' || chartData.series.length === 0) {
          return;
        }
        const ctx = self.ctx;
        const pxRatio = chartPxRatio();
        const colors = chartColors();
        const seriesCount = Math.max(1, chartData.series.length);
        const zeroBaseline = self.valToPos(0, 'y', true);
        let skippedDenseBars = false;
        ctx.save();
        ctx.beginPath();
        ctx.rect(self.bbox.left, self.bbox.top, self.bbox.width, self.bbox.height);
        ctx.clip();
        chartData.x.forEach((xValue, xIndex) => {
          const center = self.valToPos(xValue, 'x', true);
          const localGap = chartLocalXGapPixels(self, xIndex, 44 * pxRatio);
          if (localGap * 0.78 / seriesCount < 0.75 * pxRatio) {
            skippedDenseBars = true;
            return;
          }
          const clusterWidth = chartBarClusterWidthPixels(self, xIndex, seriesCount);
          const slotWidth = clusterWidth / seriesCount;
          if (slotWidth < 0.75 * pxRatio) {
            skippedDenseBars = true;
            return;
          }
          const maxBodyWidth = Math.max(Number.EPSILON, slotWidth * 0.86);
          const barWidth = Math.max(Number.EPSILON, Math.min(28 * pxRatio, maxBodyWidth));
          chartData.series.forEach((series, seriesIndex) => {
            const plotSeries = self.series[seriesIndex + 1];
            if (plotSeries && plotSeries.show === false) {
              return;
            }
            const value = series.values[xIndex];
            if (!Number.isFinite(value) || value === 0) {
              return;
            }
            const valueY = self.valToPos(value, 'y', true);
            const top = Math.min(valueY, zeroBaseline);
            const height = Math.max(1 * pxRatio, Math.abs(zeroBaseline - valueY));
            const seriesCenter = center - clusterWidth / 2 + slotWidth * seriesIndex + slotWidth / 2;
            const left = seriesCenter - barWidth / 2;
            const color = colors[seriesIndex % colors.length];
            ctx.fillStyle = chartAlphaColor(color, 0.55);
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.max(1, pxRatio);
            ctx.fillRect(left, top, barWidth, height);
            ctx.strokeRect(left, top, barWidth, height);
          });
        });
        ctx.restore();
        if (skippedDenseBars && chartStatus.textContent.indexOf('Dense bar clusters') === -1) {
          chartStatus.textContent += ' Dense bar clusters too narrow to distinguish were skipped; refine zoom to inspect them.';
        }
      }

      function chartBarClusterWidthPixels(self, xIndex, seriesCount) {
        const pxRatio = chartPxRatio();
        const localGap = chartLocalXGapPixels(self, xIndex, 44 * pxRatio);
        const minimum = 1 * pxRatio;
        return Math.max(minimum, Math.min(72 * pxRatio, localGap * 0.78));
      }

      function chartLocalXGapPixels(self, xIndex, fallback) {
        if (!chartData || chartData.x.length <= 1) {
          return Math.max(1, fallback);
        }
        const center = self.valToPos(chartData.x[xIndex], 'x', true);
        let gap = Infinity;
        if (xIndex > 0) {
          const previous = Math.abs(center - self.valToPos(chartData.x[xIndex - 1], 'x', true));
          if (Number.isFinite(previous) && previous > 0) {
            gap = Math.min(gap, previous);
          }
        }
        if (xIndex + 1 < chartData.x.length) {
          const next = Math.abs(self.valToPos(chartData.x[xIndex + 1], 'x', true) - center);
          if (Number.isFinite(next) && next > 0) {
            gap = Math.min(gap, next);
          }
        }
        return Number.isFinite(gap) && gap > 0 ? gap : Math.max(1, fallback);
      }

      function chartNominalXStep() {
        if (!chartData || chartData.x.length <= 1) {
          return chartData && chartData.xKind === 'temporal' ? 86400000 : 1;
        }
        let min = Infinity;
        for (let index = 1; index < chartData.x.length; index++) {
          const delta = chartData.x[index] - chartData.x[index - 1];
          if (Number.isFinite(delta) && delta > 0) {
            min = Math.min(min, delta);
          }
        }
        if (Number.isFinite(min)) {
          return min;
        }
        const range = finiteRange(chartData.x);
        return range && range.max > range.min
          ? (range.max - range.min) / Math.max(1, chartData.x.length)
          : (chartData.xKind === 'temporal' ? 86400000 : 1);
      }

      function chartNeedsXPadding() {
        return chartData && (chartData.chartType === 'bar' || chartData.chartType === 'box' || chartData.chartType === 'candlestick');
      }

      function chartPaddedXRange(min, max) {
        let low = Number.isFinite(min) ? min : 0;
        let high = Number.isFinite(max) ? max : low;
        if (chartData && chartData.xDomain) {
          low = Math.min(low, chartData.xDomain.min);
          high = Math.max(high, chartData.xDomain.max);
        }
        let pad = chartNominalXStep() * 0.55;
        if (!Number.isFinite(pad) || pad <= 0) {
          pad = chartData && chartData.xKind === 'temporal' ? 86400000 : 1;
        }
        if (low === high) {
          low -= pad;
          high += pad;
        } else {
          low -= pad;
          high += pad;
        }
        return [low, high];
      }

      function chartInitialXRange() {
        const range = chartData && chartData.xDomain ? chartData.xDomain : (chartData ? finiteRange(chartData.x) : null);
        if (!range) {
          return null;
        }
        if (!chartNeedsXPadding()) {
          return range;
        }
        const padded = chartPaddedXRange(range.min, range.max);
        return { min: padded[0], max: padded[1] };
      }

      function chartNeedsYRange() {
        return chartData && (chartData.chartType === 'bar' || chartData.chartType === 'box' || chartData.chartType === 'candlestick');
      }

      function chartYScaleRange(min, max) {
        const statsRange = chartData && chartData.chartType === 'box'
          ? chartBoxYRange()
          : (chartData && chartData.chartType === 'candlestick' ? chartCandlestickYRange() : null);
        let low = statsRange ? statsRange.min : (Number.isFinite(min) ? min : 0);
        let high = statsRange ? statsRange.max : (Number.isFinite(max) ? max : low);
        if (chartData && chartData.chartType === 'bar') {
          low = Math.min(0, low);
          high = Math.max(0, high);
        }
        if (low === high) {
          const pad = Math.max(1, Math.abs(low) * 0.05);
          low -= pad;
          high += pad;
        } else {
          const pad = Math.abs(high - low) * 0.05;
          low -= pad;
          high += pad;
        }
        return [low, high];
      }

      function chartCandlestickYRange() {
        let min = Infinity;
        let max = -Infinity;
        chartData.candlesticks.forEach(candle => {
          min = Math.min(min, candle.low);
          max = Math.max(max, candle.high);
        });
        return min === Infinity ? null : { min, max };
      }

      function chartBoxYRange() {
        let min = Infinity;
        let max = -Infinity;
        chartData.boxSeries.forEach(series => {
          series.stats.forEach(stats => {
            if (!stats) {
              return;
            }
            min = Math.min(min, stats.min);
            max = Math.max(max, stats.max);
          });
        });
        return min === Infinity ? null : { min, max };
      }

      function drawChartCandlesticks(self) {
        if (!chartData || chartData.chartType !== 'candlestick' || chartData.candlesticks.length === 0) {
          return;
        }
        const plotSeries = self.series[1];
        if (plotSeries && plotSeries.show === false) {
          return;
        }
        const ctx = self.ctx;
        const pxRatio = chartPxRatio();
        const colors = chartCandlestickColors();
        ctx.save();
        ctx.beginPath();
        ctx.rect(self.bbox.left, self.bbox.top, self.bbox.width, self.bbox.height);
        ctx.clip();
        chartData.candlesticks.forEach((candle, index) => {
          const center = self.valToPos(candle.x, 'x', true);
          const localGap = chartLocalXGapPixels(self, index, 16 * pxRatio);
          const bodyWidth = Math.max(1 * pxRatio, Math.min(18 * pxRatio, localGap * 0.68));
          const highY = self.valToPos(candle.high, 'y', true);
          const lowY = self.valToPos(candle.low, 'y', true);
          const openY = self.valToPos(candle.open, 'y', true);
          const closeY = self.valToPos(candle.close, 'y', true);
          const rising = candle.close >= candle.open;
          const color = rising ? colors.up : colors.down;
          const bodyTop = Math.min(openY, closeY);
          const bodyHeight = Math.max(1 * pxRatio, Math.abs(closeY - openY));
          const bodyLeft = center - bodyWidth / 2;
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(1, pxRatio);
          ctx.beginPath();
          ctx.moveTo(center, highY);
          ctx.lineTo(center, lowY);
          ctx.stroke();
          ctx.fillStyle = rising ? colors.hollow : color;
          ctx.fillRect(bodyLeft, bodyTop, bodyWidth, bodyHeight);
          ctx.strokeRect(bodyLeft, bodyTop, bodyWidth, bodyHeight);
        });
        ctx.restore();
      }

      function chartCandlestickColors() {
        return {
          up: cssColor('--vscode-charts-green', '#2ea043'),
          down: cssColor('--vscode-charts-red', '#d73a49'),
          hollow: cssColor('--vscode-editor-background', '#1e1e1e')
        };
      }

      function drawChartBoxes(self) {
        if (!chartData || chartData.chartType !== 'box' || !chartData.boxSeries.length) {
          return;
        }
        const ctx = self.ctx;
        const pxRatio = chartPxRatio();
        const colors = chartColors();
        const groupWidth = chartBoxGroupWidth(self) * pxRatio;
        const seriesCount = Math.max(1, chartData.boxSeries.length);
        const slotWidth = groupWidth / seriesCount;
        if (slotWidth < 1.75 * pxRatio) {
          if (chartStatus.textContent.indexOf('Dense box groups') === -1) {
            chartStatus.textContent += ' Dense box groups too narrow to distinguish were skipped; refine zoom or select fewer Y columns.';
          }
          return;
        }
        const boxWidth = Math.max(Number.EPSILON, Math.min(
          28 * pxRatio,
          slotWidth * 0.72,
          slotWidth - Math.max(1, pxRatio)
        ));
        ctx.save();
        ctx.beginPath();
        ctx.rect(self.bbox.left, self.bbox.top, self.bbox.width, self.bbox.height);
        ctx.clip();
        chartData.x.forEach((xValue, xIndex) => {
          const center = self.valToPos(xValue, 'x', true);
          chartData.boxSeries.forEach((series, seriesIndex) => {
            const plotSeries = self.series[seriesIndex + 1];
            if (plotSeries && plotSeries.show === false) {
              return;
            }
            const stats = series.stats[xIndex];
            if (!stats) {
              return;
            }
            const color = colors[seriesIndex % colors.length];
            const seriesCenter = center - groupWidth / 2 + slotWidth * seriesIndex + slotWidth / 2;
            drawOneBox(ctx, self, stats, seriesCenter, boxWidth, color);
          });
        });
        ctx.restore();
      }

      function drawOneBox(ctx, self, stats, center, width, color) {
        const minY = self.valToPos(stats.min, 'y', true);
        const q1Y = self.valToPos(stats.q1, 'y', true);
        const medianY = self.valToPos(stats.median, 'y', true);
        const q3Y = self.valToPos(stats.q3, 'y', true);
        const maxY = self.valToPos(stats.max, 'y', true);
        const boxTop = Math.min(q1Y, q3Y);
        const boxHeight = Math.max(1, Math.abs(q3Y - q1Y));
        const left = center - width / 2;
        const capWidth = width * 0.68;
        ctx.lineWidth = Math.max(1, chartPxRatio());
        ctx.strokeStyle = color;
        ctx.fillStyle = chartAlphaColor(color, 0.22);
        ctx.beginPath();
        ctx.moveTo(center, maxY);
        ctx.lineTo(center, minY);
        ctx.moveTo(center - capWidth / 2, minY);
        ctx.lineTo(center + capWidth / 2, minY);
        ctx.moveTo(center - capWidth / 2, maxY);
        ctx.lineTo(center + capWidth / 2, maxY);
        ctx.stroke();
        ctx.fillRect(left, boxTop, width, boxHeight);
        ctx.strokeRect(left, boxTop, width, boxHeight);
        ctx.beginPath();
        ctx.moveTo(left, medianY);
        ctx.lineTo(left + width, medianY);
        ctx.stroke();
      }

      function chartBoxGroupWidth(self) {
        if (!chartData || chartData.x.length <= 1) {
          return 36;
        }
        let minGap = Infinity;
        for (let index = 1; index < chartData.x.length; index++) {
          const left = self.valToPos(chartData.x[index - 1], 'x');
          const right = self.valToPos(chartData.x[index], 'x');
          const gap = Math.abs(right - left);
          if (Number.isFinite(gap) && gap > 0) {
            minGap = Math.min(minGap, gap);
          }
        }
        if (!Number.isFinite(minGap)) {
          return 36;
        }
        return Math.max(Number.EPSILON, Math.min(52, minGap * 0.72));
      }

      function chartBoxStatsAt(seriesIndex, valueIndex) {
        if (!chartData || !Array.isArray(chartData.boxSeries) || valueIndex === null || valueIndex === undefined) {
          return null;
        }
        const series = chartData.boxSeries[seriesIndex];
        return series && series.stats ? series.stats[valueIndex] || null : null;
      }

      function chartPxRatio() {
        const pxRatio = window.uPlot && Number(window.uPlot.pxRatio);
        return Number.isFinite(pxRatio) && pxRatio > 0 ? pxRatio : (window.devicePixelRatio || 1);
      }

      function chartAlphaColor(color, alpha) {
        const match = /^#([0-9a-f]{6})$/i.exec(String(color || ''));
        if (!match) {
          return color;
        }
        const value = parseInt(match[1], 16);
        const red = (value >> 16) & 255;
        const green = (value >> 8) & 255;
        const blue = value & 255;
        return 'rgba(' + red + ', ' + green + ', ' + blue + ', ' + alpha + ')';
      }

      function updateChartTooltipFromUPlot(self) {
        if (!self || !chartData || chartData.x.length === 0 || chartPanel.hidden) {
          hideChartTooltip();
          return;
        }
        const index = typeof self.cursor.idx === 'number' ? self.cursor.idx : -1;
        if (index < 0 || index >= chartData.x.length) {
          hideChartTooltip();
          return;
        }
        const lines = [chartData.xColumn + ': ' + chartXLabel(index)];
        if (chartData.chartType === 'candlestick') {
          const plotSeries = self.series[1];
          const candle = chartData.candlesticks[index];
          if (!plotSeries || plotSeries.show !== false) {
            lines.push(chartOhlcTooltipLabel('Open', chartData.ohlcColumns.open) + ': ' + formatChartNumber(candle.open));
            lines.push(chartOhlcTooltipLabel('High', chartData.ohlcColumns.high) + ': ' + formatChartNumber(candle.high));
            lines.push(chartOhlcTooltipLabel('Low', chartData.ohlcColumns.low) + ': ' + formatChartNumber(candle.low));
            lines.push(chartOhlcTooltipLabel('Close', chartData.ohlcColumns.close) + ': ' + formatChartNumber(candle.close));
          }
        } else {
          chartData.series.forEach((series, seriesIndex) => {
            const plotSeries = self.series[seriesIndex + 1];
            if (plotSeries && plotSeries.show === false) {
              return;
            }
            if (chartData.chartType === 'box') {
              const stats = chartBoxStatsAt(seriesIndex, index);
              lines.push(series.columnName + ': ' + (stats
                ? 'n=' + formatUiCount(stats.count) +
                  ' min ' + formatChartNumber(stats.min) +
                  ' q1 ' + formatChartNumber(stats.q1) +
                  ' med ' + formatChartNumber(stats.median) +
                  ' q3 ' + formatChartNumber(stats.q3) +
                  ' max ' + formatChartNumber(stats.max)
                : 'null'));
            } else {
              const value = series.values[index];
              lines.push(series.columnName + ': ' + (Number.isFinite(value) ? formatChartNumber(value) : 'null'));
            }
          });
        }
        chartTooltip.textContent = lines.join('\\n');
        chartTooltip.hidden = false;
        const wrapRect = chartCanvasWrap.getBoundingClientRect();
        const overRect = self.over.getBoundingClientRect();
        const left = overRect.left - wrapRect.left + Number(self.cursor.left || 0) + 12;
        const top = overRect.top - wrapRect.top + Number(self.cursor.top || 0) + 12;
        chartTooltip.style.left = Math.min(Math.max(4, wrapRect.width - 260), Math.max(4, left)) + 'px';
        chartTooltip.style.top = Math.min(Math.max(4, wrapRect.height - (chartData.chartType === 'candlestick' ? 128 : 80)), Math.max(4, top)) + 'px';
      }

      function chartOhlcTooltipLabel(role, columnName) {
        return columnName ? role + ' (' + columnName + ')' : role;
      }

      function hideChartTooltip() {
        chartTooltip.hidden = true;
      }

      function chartXScaleRange(self) {
        const scale = self && self.scales && self.scales.x;
        if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max) || scale.max <= scale.min) {
          return null;
        }
        return { min: scale.min, max: scale.max };
      }

      function resetChartZoom() {
        if (!chartUPlot) {
          return;
        }
        const xRange = chartFullXRange;
        if (!xRange) {
          clearChartSelection();
          hideChartTooltip();
          clearChartAutoRefineTimer();
          updateChartZoomState(chartUPlot);
          return;
        }
        chartZoomStateSuspended = true;
        try {
          chartUPlot.batch(() => {
            chartUPlot.setScale('x', { min: xRange.min, max: xRange.max });
            chartUPlot.setScale('y', { min: null, max: null });
          });
        } finally {
          chartZoomStateSuspended = false;
        }
        clearChartSelection();
        hideChartTooltip();
        clearChartAutoRefineTimer();
        updateChartZoomState(chartUPlot);
      }

      function clearChartSelection() {
        if (chartUPlot && typeof chartUPlot.setSelect === 'function') {
          chartUPlot.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
        }
      }

      function updateChartZoomState(self) {
        if (chartZoomStateSuspended) {
          return;
        }
        chartZoomed = chartRangeIsZoomed(chartFullXRange, chartXScaleRange(self));
        if (chartZoomed) {
          queueChartAutoRefine();
        } else {
          clearChartAutoRefineTimer();
        }
        updateChartControls();
      }

      function currentChartZoomRange() {
        const initial = chartFullXRange;
        const current = chartXScaleRange(chartUPlot);
        if (!initial || !current || !chartRangeIsZoomed(initial, current)) {
          return null;
        }
        const min = Math.max(current.min, Math.min(initial.min, initial.max));
        const max = Math.min(current.max, Math.max(initial.min, initial.max));
        return max > min ? { min, max } : null;
      }

      function queueChartAutoRefine() {
        const range = currentChartZoomRange();
        if (!range || !chartCanExport() || chartControlsDirty || !chartDataCanAutoRefine()) {
          clearChartAutoRefineTimer();
          return;
        }
        const visiblePoints = chartVisibleSamplePointCount(range);
        if (visiblePoints >= chartAutoRefineMinVisiblePoints() || chartData.eligibleRowCount <= visiblePoints) {
          clearChartAutoRefineTimer();
          return;
        }
        const key = chartZoomRangeKey(range);
        if (key === chartLastAutoRefineKey) {
          return;
        }
        if (chartAutoRefineTimer) {
          clearTimeout(chartAutoRefineTimer);
        }
        chartAutoRefineTimer = setTimeout(() => {
          chartAutoRefineTimer = 0;
          const current = currentChartZoomRange();
          if (!current || chartZoomRangeKey(current) !== key || !chartCanExport() || chartControlsDirty) {
            return;
          }
          chartLastAutoRefineKey = key;
          requestChartDataForRange(current, 'Auto-refining zoom range...');
        }, CHART_AUTO_REFINE_DELAY_MS);
      }

      function clearChartAutoRefineTimer() {
        if (chartAutoRefineTimer) {
          clearTimeout(chartAutoRefineTimer);
          chartAutoRefineTimer = 0;
        }
      }

      function chartVisibleSamplePointCount(range) {
        if (!chartData || !Array.isArray(chartData.x)) {
          return 0;
        }
        let count = 0;
        chartData.x.forEach(value => {
          if (value >= range.min && value <= range.max) {
            count += 1;
          }
        });
        return count;
      }

      function chartZoomRangeKey(range) {
        return Number(range.min).toPrecision(12) + ':' + Number(range.max).toPrecision(12);
      }

      function chartZoomMinSampledPoints() {
        return positiveIntegerSetting(settings.chartZoomMinSampledPoints, DEFAULT_SETTINGS.chartZoomMinSampledPoints);
      }

      function chartAutoRefineMinVisiblePoints() {
        const configuredMinimum = chartZoomMinSampledPoints();
        const availableSample = chartData ? Math.max(1, chartData.sampledPointCount) : configuredMinimum;
        return Math.min(configuredMinimum, availableSample);
      }

      function chartDataCanAutoRefine() {
        if (!chartData) {
          return false;
        }
        return chartData.algorithm.indexOf('minmax-bucket/') === 0 ||
          chartData.algorithm.indexOf('bar-cluster-even/') === 0 ||
          chartData.algorithm.indexOf('box-bucket/') === 0 ||
          chartData.algorithm.indexOf('ohlc-bucket/') === 0;
      }

      function chartZoomMaxSampledPoints() {
        return Math.max(
          chartZoomMinSampledPoints(),
          positiveIntegerSetting(settings.chartZoomMaxSampledPoints, DEFAULT_SETTINGS.chartZoomMaxSampledPoints)
        );
      }

      function notifyChartPanelState(rendered) {
        vscode.postMessage({
          type: 'chartPanelState',
          version: data.version,
          open: !chartPanel.hidden,
          rendered: rendered === true
        });
      }

      function notifyChartRendered() {
        notifyChartPanelState(true);
        vscode.postMessage({
          type: 'chartRendered',
          version: data.version,
          requestId: latestChartRequestId,
          selection: currentChartSelection()
        });
      }

      function currentChartSelection() {
        const roles = selectedCandlestickColumns();
        return {
          chartType: selectedChartType(),
          xColumn: String(chartXColumn.value || ''),
          yColumns: selectedChartYColumns(),
          groupByColumn: selectedChartGroupColumn(),
          openColumn: roles.open,
          highColumn: roles.high,
          lowColumn: roles.low,
          closeColumn: roles.close
        };
      }

      function renderedChartCanvas() {
        if (chartUPlot && chartUPlot.root && typeof chartUPlot.root.querySelector === 'function') {
          return chartUPlot.root.querySelector('canvas');
        }
        return chartCanvasWrap ? chartCanvasWrap.querySelector('.uplot canvas, canvas') : null;
      }

      function destroyChartPlot() {
        if (chartUPlot && typeof chartUPlot.destroy === 'function') {
          try {
            chartUPlot.destroy();
          } catch (error) {
            // Ignore cleanup errors from a half-created chart.
          }
        }
        chartUPlot = null;
        chartZoomed = false;
        clearChartAutoRefineTimer();
        if (chartPlot) {
          chartPlot.textContent = '';
        }
        chartLegend.textContent = '';
        hideChartTooltip();
      }

      function chartXAxisLabel(value) {
        if (!chartData || chartData.x.length === 0) {
          return '';
        }
        if (chartData.xKind !== 'temporal') {
          return formatChartNumber(value);
        }
        const index = nearestChartXIndex(value);
        return chartData.xText[index] || formatChartTemporalValue(chartData.x[index]);
      }

      function chartThinnedXAxisLabels(self, splits) {
        if (!Array.isArray(splits) || splits.length === 0) {
          return [];
        }
        const labels = splits.map(value => chartXAxisTickLabel(self, value));
        const maxLabels = chartMaxVisibleXAxisLabels(self, labels);
        const suppressEdges = !!chartData && chartData.xKind === 'temporal' && splits.length > 2;
        const first = suppressEdges ? 1 : 0;
        const last = suppressEdges ? splits.length - 2 : splits.length - 1;
        if (first > last) {
          return labels;
        }
        const visibleCount = Math.min(maxLabels, last - first + 1);
        const visibleIndexes = new Set();
        const step = Math.max(1, Math.ceil((last - first) / Math.max(1, visibleCount - 1)));
        for (let index = first; index <= last; index += step) {
          visibleIndexes.add(index);
        }
        visibleIndexes.add(last);
        return labels.map((label, index) => visibleIndexes.has(index) ? label : '');
      }

      function chartXAxisTickLabel(self, value) {
        if (!chartData || chartData.xKind !== 'temporal') {
          return chartXAxisLabel(value);
        }
        return chartTemporalTickLabel(self, value);
      }

      function chartTemporalTickLabel(self, value) {
        if (!Number.isFinite(value)) {
          return '';
        }
        const span = chartVisibleXSpan(self);
        const text = chartXAxisLabel(value);
        if (/^([01]?\\d|2[0-3]):[0-5]\\d/.test(text)) {
          return chartShortTimeLabel(value, span);
        }
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) {
          return text.length > 12 ? text.slice(0, 12) : text;
        }
        const day = 24 * 60 * 60 * 1000;
        if (span <= day) {
          return chartShortTimeLabel(value, span);
        }
        if (span <= 93 * day) {
          return chartPad2(date.getUTCMonth() + 1) + '-' + chartPad2(date.getUTCDate());
        }
        if (span <= 730 * day) {
          return date.getUTCFullYear() + '-' + chartPad2(date.getUTCMonth() + 1);
        }
        return String(date.getUTCFullYear());
      }

      function chartShortTimeLabel(value, span) {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) {
          return '';
        }
        const base = chartPad2(date.getUTCHours()) + ':' + chartPad2(date.getUTCMinutes());
        if (span > 60 * 60 * 1000) {
          return base;
        }
        const seconds = chartPad2(date.getUTCSeconds());
        if (span > 10 * 1000) {
          return base + ':' + seconds;
        }
        return base + ':' + seconds + '.' + chartPad3(date.getUTCMilliseconds());
      }

      function chartVisibleXSpan(self) {
        const scale = self && self.scales && self.scales.x;
        if (scale && Number.isFinite(scale.min) && Number.isFinite(scale.max) && scale.max > scale.min) {
          return scale.max - scale.min;
        }
        const range = chartInitialXRange();
        return range ? Math.max(0, range.max - range.min) : 0;
      }

      function chartPad2(value) {
        const text = String(Math.max(0, Math.floor(Number(value) || 0)));
        return text.length < 2 ? '0' + text : text;
      }

      function chartPad3(value) {
        const text = String(Math.max(0, Math.floor(Number(value) || 0)));
        return text.length === 1 ? '00' + text : text.length === 2 ? '0' + text : text;
      }

      function chartMaxVisibleXAxisLabels(self, labels) {
        const plotWidth = chartXAxisPlotWidth(self);
        const maxLabelChars = labels.reduce((max, label) => Math.max(max, String(label || '').length), 1);
        const temporal = !!chartData && chartData.xKind === 'temporal';
        const charWidth = temporal ? 7.5 : 7;
        const padding = temporal ? 28 : 24;
        const minSpacing = Math.min(
          temporal ? 150 : 160,
          Math.max(temporal ? 72 : 60, Math.ceil(maxLabelChars * charWidth + padding))
        );
        return clampInteger(Math.floor(plotWidth / minSpacing), 2, Math.max(2, labels.length));
      }

      function chartXAxisPlotWidth(self) {
        if (self && self.over && typeof self.over.getBoundingClientRect === 'function') {
          const rect = self.over.getBoundingClientRect();
          if (Number.isFinite(rect.width) && rect.width > 0) {
            return rect.width;
          }
        }
        if (self && self.bbox && Number.isFinite(self.bbox.width) && self.bbox.width > 0) {
          return self.bbox.width;
        }
        if (chartCanvasWrap && Number.isFinite(chartCanvasWrap.clientWidth) && chartCanvasWrap.clientWidth > 0) {
          return Math.max(0, chartCanvasWrap.clientWidth - 80);
        }
        return 320;
      }

      function nearestChartXIndex(value) {
        const xValues = chartData.x;
        if (xValues.length <= 1 || !Number.isFinite(value)) {
          return 0;
        }
        let low = 0;
        let high = xValues.length - 1;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (xValues[middle] < value) {
            low = middle + 1;
          } else {
            high = middle;
          }
        }
        if (low <= 0) {
          return 0;
        }
        const left = low - 1;
        return Math.abs(xValues[left] - value) <= Math.abs(xValues[low] - value) ? left : low;
      }

      function chartErrorMessage(error) {
        return error && error.message ? String(error.message) : String(error || 'unknown error');
      }

      function chartXLabel(index) {
        if (!chartData || chartData.x.length === 0) {
          return '';
        }
        const bounded = clampInteger(index, 0, chartData.x.length - 1);
        return chartData.xKind === 'temporal'
          ? (chartData.xText[bounded] || formatChartTemporalValue(chartData.x[bounded]))
          : formatChartNumber(chartData.x[bounded]);
      }

      function finiteRange(values) {
        let min = Infinity;
        let max = -Infinity;
        values.forEach(value => {
          if (!Number.isFinite(value)) {
            return;
          }
          min = Math.min(min, value);
          max = Math.max(max, value);
        });
        return min === Infinity ? null : { min, max };
      }

      function chartColors() {
        return ['#4ec9b0', '#dcdcaa', '#569cd6', '#c586c0', '#ce9178', '#b5cea8', '#9cdcfe'];
      }

      function cssColor(name, fallback) {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name);
        return value && value.trim() ? value.trim() : fallback;
      }

      function formatChartNumber(value) {
        if (!Number.isFinite(value)) {
          return '';
        }
        const normalized = Object.is(value, -0) ? 0 : value;
        const places = clampInteger(settings.chartDecimalPlaces, 0, 12);
        const abs = Math.abs(normalized);
        if (abs !== 0 && (abs >= 1000000 || abs < 0.001)) {
          return normalized.toExponential(places);
        }
        return normalized.toLocaleString(undefined, {
          minimumFractionDigits: places,
          maximumFractionDigits: places
        });
      }

      function formatChartTemporalValue(value) {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) {
          return '';
        }
        return date.toISOString();
      }

      function refreshChartFormatting() {
        if (!chartUPlot || !chartRendered) {
          return;
        }
        if (typeof chartUPlot.redraw === 'function') {
          chartUPlot.redraw(true, true);
        }
        if (typeof chartUPlot.setCursor === 'function' && chartUPlot.cursor) {
          const left = Number(chartUPlot.cursor.left);
          const top = Number(chartUPlot.cursor.top);
          if (Number.isFinite(left) && Number.isFinite(top)) {
            chartUPlot.setCursor({ left, top }, false);
          }
        }
        updateChartTooltipFromUPlot(chartUPlot);
      }

      function applySettings(value) {
        const previousChartDecimalPlaces = settings.chartDecimalPlaces;
        settings = normalizeSettings(value || {});
        layout = layoutFromSettings(settings);
        syncSettingsControls();
        const root = document.documentElement;
        root.style.setProperty('--cell-width', layout.cellWidth + 'px');
        root.style.setProperty('--row-height', layout.rowHeight + 'px');
        root.style.setProperty('--header-height', layout.headerHeight + 'px');
        root.style.setProperty('--cell-padding-x', layout.cellPaddingX + 'px');
        root.style.setProperty('--panel-font-size', settings.fontSize > 0 ? settings.fontSize + 'px' : 'var(--vscode-font-size)');
        if (settings.chartDecimalPlaces !== previousChartDecimalPlaces) {
          refreshChartFormatting();
        }
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
        const chartZoomMinSampledPoints = positiveIntegerSetting(value.chartZoomMinSampledPoints, DEFAULT_SETTINGS.chartZoomMinSampledPoints);
        const chartZoomMaxSampledPoints = Math.max(
          chartZoomMinSampledPoints,
          positiveIntegerSetting(value.chartZoomMaxSampledPoints, DEFAULT_SETTINGS.chartZoomMaxSampledPoints)
        );
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
          copyExportConfirmCellThreshold: positiveIntegerSetting(value.copyExportConfirmCellThreshold, DEFAULT_SETTINGS.copyExportConfirmCellThreshold),
          localDataServerFullExportCellLimit: positiveIntegerSetting(value.localDataServerFullExportCellLimit, DEFAULT_SETTINGS.localDataServerFullExportCellLimit),
          elapsedTimeDisplay: normalizeElapsedTimeDisplay(value.elapsedTimeDisplay),
          chartDecimalPlaces: boundedSetting(value.chartDecimalPlaces, DEFAULT_SETTINGS.chartDecimalPlaces, 0, 12),
          chartZoomMinSampledPoints,
          chartZoomMaxSampledPoints,
          arrayDisplayFormat: normalizeArrayDisplayFormat(value.arrayDisplayFormat),
          functionDisplayStrategy: normalizeQResultDisplayStrategy(value.functionDisplayStrategy, DEFAULT_SETTINGS.functionDisplayStrategy),
          dictionaryDisplayStrategy: normalizeQResultDisplayStrategy(value.dictionaryDisplayStrategy, DEFAULT_SETTINGS.dictionaryDisplayStrategy),
          listDisplayStrategy: normalizeQResultDisplayStrategy(value.listDisplayStrategy, DEFAULT_SETTINGS.listDisplayStrategy),
          objectDisplayStrategy: normalizeQResultDisplayStrategy(value.objectDisplayStrategy, DEFAULT_SETTINGS.objectDisplayStrategy)
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
        settingsCopyExportConfirmCellThreshold.value = String(settings.copyExportConfirmCellThreshold);
        settingsLocalDataServerFullExportCellLimit.value = String(settings.localDataServerFullExportCellLimit);
        settingsChartDecimalPlaces.value = String(settings.chartDecimalPlaces);
        settingsElapsedTimeDisplay.value = settings.elapsedTimeDisplay;
        settingsArrayDisplayFormat.value = settings.arrayDisplayFormat;
        settingsFunctionDisplayStrategy.value = settings.functionDisplayStrategy;
        settingsDictionaryDisplayStrategy.value = settings.dictionaryDisplayStrategy;
        settingsListDisplayStrategy.value = settings.listDisplayStrategy;
        settingsObjectDisplayStrategy.value = settings.objectDisplayStrategy;
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
          copyExportConfirmCellThreshold: settings.copyExportConfirmCellThreshold,
          localDataServerFullExportCellLimit: settings.localDataServerFullExportCellLimit,
          elapsedTimeDisplay: settings.elapsedTimeDisplay,
          chartDecimalPlaces: settings.chartDecimalPlaces,
          chartZoomMinSampledPoints: settings.chartZoomMinSampledPoints,
          chartZoomMaxSampledPoints: settings.chartZoomMaxSampledPoints,
          arrayDisplayFormat: settings.arrayDisplayFormat,
          functionDisplayStrategy: settings.functionDisplayStrategy,
          dictionaryDisplayStrategy: settings.dictionaryDisplayStrategy,
          listDisplayStrategy: settings.listDisplayStrategy,
          objectDisplayStrategy: settings.objectDisplayStrategy
        };
        next[key] = value;
        applySettings(next);
        if (key === 'cellWidth' || key === 'fontSize' || key === 'density') {
          autoColumnWidths = Object.create(null);
        }
        if (key === 'arrayDisplayFormat') {
          slice = emptySlice();
          pendingRequestKey = '';
          autoColumnWidths = Object.create(null);
          if (String(searchInput.value || '').length > 0) {
            queueSearchRows();
          }
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

      function updatePositiveIntegerSetting(key, input) {
        const value = Number(input.value);
        if (!Number.isFinite(value) || value < 1) {
          syncSettingsControls();
          return;
        }
        updateSetting(key, Math.floor(value));
      }

      function positiveIntegerSetting(value, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) {
          return fallback;
        }
        const integer = Math.floor(number);
        return integer >= 1 ? integer : fallback;
      }

      function setSettingsSectionsOpen(open) {
        settingsMenu.querySelectorAll('.settings-section').forEach(section => {
          section.open = open;
        });
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

      function normalizeArrayDisplayFormat(value) {
        return value === 'space' || value === 'raw' ? value : 'commaSpace';
      }

      function normalizeQResultDisplayStrategy(value, fallback) {
        if (value === 'grid' || value === 'table') {
          return 'grid';
        }
        if (value === 'qText' || value === 'text') {
          return 'qText';
        }
        return fallback;
      }

      function updateSummary() {
        if (!data.hasResult) {
          return;
        }
        if (data.canceled) {
          summary.textContent = 'Query canceled' +
            (data.connectionName ? ' | ' + data.connectionName : '') +
            ' | ' + formatElapsedMs(data.elapsedMs, settings.elapsedTimeDisplay);
          return;
        }
        if (isTextResult()) {
          summary.textContent = 'Text output' +
            (data.connectionName ? ' | ' + data.connectionName : '') +
            ' | ' + formatElapsedMs(data.elapsedMs, settings.elapsedTimeDisplay);
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
        return value.error || value.canceled ? value.messages.slice().join('\\n') : '';
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
        if (isTextResult()) {
          renderTextResult();
          return;
        }
        viewport.hidden = false;
        textViewport.hidden = true;
        textViewer.textContent = '';
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

      function renderTextResult() {
        viewport.hidden = true;
        textViewport.hidden = false;
        header.textContent = '';
        rowsLayer.textContent = '';
        empty.hidden = true;
        canvas.style.width = '';
        canvas.style.height = '';
        const text = data.text || '';
        if (textViewer.textContent !== text) {
          textViewer.textContent = text;
        }
        updateAutoFitControlState();
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
        sendSelectionChanged();
        renderNow();
      }

      function updateSelectionLabel() {
        if (isTextResult()) {
          selectionLabel.textContent = 'Plain text output';
          return;
        }
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

      function sendSelectionChanged() {
        vscode.postMessage({
          type: 'selectionChanged',
          version: data.version,
          range: normalizedSelection()
        });
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
        if (isTextResult()) {
          vscode.postMessage({
            type: 'copyText',
            version: data.version
          });
          return;
        }
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
        if (isTextResult()) {
          vscode.postMessage({
            type: 'exportText',
            version: data.version
          });
          return;
        }
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
          mode: 'table',
          columns: [],
          allColumns: [],
          hiddenColumnNames: [],
          hiddenColumnCount: 0,
          rowCount: 0,
          text: '',
          messages: [],
          guardrailMessage: '',
          query: '',
          connectionName: '',
          elapsedMs: 0,
          error: false,
          canceled: false,
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
    copyExportConfirmCellThreshold: positiveIntegerConfigSetting(
      config.get<number>('copyExportConfirmCellThreshold'),
      DEFAULT_PANEL_SETTINGS.copyExportConfirmCellThreshold
    ),
    localDataServerFullExportCellLimit: localDataServerFullExportCellLimitValue(
      config.get<number>('localDataServerFullExportCellLimit'),
      DEFAULT_PANEL_SETTINGS.localDataServerFullExportCellLimit
    ),
    elapsedTimeDisplay: panelElapsedTimeDisplay(config.get<string>('elapsedTimeDisplay')),
    chartDecimalPlaces: chartDecimalPlacesSettingValue(config.get<number>('kdbPanel.chartDecimalPlaces')),
    ...chartZoomSamplePointSettings(config),
    arrayDisplayFormat: panelArrayDisplayFormat(config.get<string>('kdbPanel.arrayDisplayFormat')),
    functionDisplayStrategy: panelQResultDisplayStrategy(config.get<string>('kdbPanel.functionDisplayStrategy'), 'qText'),
    dictionaryDisplayStrategy: panelQResultDisplayStrategy(config.get<string>('kdbPanel.dictionaryDisplayStrategy'), 'grid'),
    listDisplayStrategy: panelQResultDisplayStrategy(config.get<string>('kdbPanel.listDisplayStrategy'), 'grid'),
    objectDisplayStrategy: panelQResultDisplayStrategy(config.get<string>('kdbPanel.objectDisplayStrategy'), 'grid'),
  };
}

function panelCellTextOptions(): CellTextOptions {
  return { arrayDisplayFormat: panelSettings().arrayDisplayFormat };
}

function chartMaxSourceRowsSetting(): number {
  const value = vscode.workspace
    .getConfiguration('kdb-sqltools.results.kdbPanel')
    .get<number>('chartMaxSourceRows');
  return chartMaxSourceRowsSettingValue(value);
}

function chartMaxSourceRowsSettingValue(value: any, fallback = CHART_MAX_SOURCE_ROWS): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  const integer = Math.floor(number);
  return integer >= 1 ? integer : fallback;
}

function chartDecimalPlacesSettingValue(value: any, fallback = CHART_DECIMAL_PLACES_DEFAULT): number {
  return boundedSettingNumber(value, fallback, CHART_DECIMAL_PLACES_MIN, CHART_DECIMAL_PLACES_MAX);
}

function chartZoomSamplePointSettings(config = vscode.workspace.getConfiguration('kdb-sqltools.results')): Pick<KdbPanelSettings, 'chartZoomMinSampledPoints' | 'chartZoomMaxSampledPoints'> {
  const min = chartZoomMinSampledPointsSettingValue(config.get<number>('kdbPanel.chartZoomMinSampledPoints'));
  const max = chartZoomMaxSampledPointsSettingValue(config.get<number>('kdbPanel.chartZoomMaxSampledPoints'), min);
  return {
    chartZoomMinSampledPoints: min,
    chartZoomMaxSampledPoints: max,
  };
}

function chartZoomMinSampledPointsSettingValue(value: any, fallback = CHART_ZOOM_MIN_SAMPLED_POINTS): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  const integer = Math.floor(number);
  return integer >= 1 ? integer : fallback;
}

function chartZoomMaxSampledPointsSettingValue(
  value: any,
  minSampledPoints = CHART_ZOOM_MIN_SAMPLED_POINTS,
  fallback = CHART_ZOOM_MAX_SAMPLED_POINTS
): number {
  const min = chartZoomMinSampledPointsSettingValue(minSampledPoints);
  const number = Number(value);
  const integer = Number.isFinite(number) ? Math.floor(number) : fallback;
  return integer >= min ? integer : min;
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
  if (key === 'cellWidth' || key === 'rowHeight' || key === 'fontSize') {
    return `${density}.${key}`;
  }
  if (
    key === 'arrayDisplayFormat' ||
    key === 'chartDecimalPlaces' ||
    key === 'functionDisplayStrategy' ||
    key === 'dictionaryDisplayStrategy' ||
    key === 'listDisplayStrategy' ||
    key === 'objectDisplayStrategy'
  ) {
    return `kdbPanel.${key}`;
  }
  return key;
}

function panelTitle(panelNumber: number): string {
  return panelNumber <= 1 ? 'kdb Results' : `kdb Results ${panelNumber}`;
}

function isTextPanelResult(result: KdbPanelResult): result is KdbPanelTextResult {
  return result.mode === 'text';
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
  copyExportConfirmCellThreshold: positiveIntegerSettingUpdate,
  localDataServerFullExportCellLimit: positiveIntegerSettingUpdate,
  elapsedTimeDisplay: elapsedTimeDisplaySettingUpdate,
  chartDecimalPlaces: value => numberSettingUpdate(value, CHART_DECIMAL_PLACES_MIN, CHART_DECIMAL_PLACES_MAX),
  arrayDisplayFormat: arrayDisplayFormatSettingUpdate,
  functionDisplayStrategy: value => qResultDisplayStrategySettingUpdate(value, 'qText'),
  dictionaryDisplayStrategy: value => qResultDisplayStrategySettingUpdate(value, 'grid'),
  listDisplayStrategy: value => qResultDisplayStrategySettingUpdate(value, 'grid'),
  objectDisplayStrategy: value => qResultDisplayStrategySettingUpdate(value, 'grid'),
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

function positiveIntegerConfigSetting(value: any, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  const integer = Math.floor(number);
  return integer >= 1 ? integer : fallback;
}

function panelDensity(value: any): KdbPanelDensity {
  return value === 'compact' || value === 'comfortable' ? value : 'standard';
}

function panelElapsedTimeDisplay(value: any): KdbPanelElapsedTimeDisplay {
  return value === 'milliseconds' ? 'milliseconds' : 'auto';
}

function panelArrayDisplayFormat(value: any): ArrayDisplayFormat {
  return value === 'space' || value === 'raw' ? value : 'commaSpace';
}

function panelQResultDisplayStrategy(value: any, fallback: KdbPanelQResultDisplayStrategy): KdbPanelQResultDisplayStrategy {
  if (value === 'grid' || value === 'table') {
    return 'grid';
  }
  if (value === 'qText' || value === 'text') {
    return 'qText';
  }
  return fallback;
}

function numberSettingUpdate(value: any, min: number, max: number): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.min(Math.max(Math.floor(number), min), max);
}

function positiveIntegerSettingUpdate(value: any): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  const integer = Math.floor(number);
  return integer >= 1 ? integer : null;
}

function densitySettingUpdate(value: any): string | null {
  return value === 'compact' || value === 'standard' || value === 'comfortable' ? value : null;
}

function elapsedTimeDisplaySettingUpdate(value: any): string | null {
  return value === 'auto' || value === 'milliseconds' ? value : null;
}

function arrayDisplayFormatSettingUpdate(value: any): string | null {
  return value === 'commaSpace' || value === 'space' || value === 'raw' ? value : null;
}

function qResultDisplayStrategySettingUpdate(value: any, fallback: KdbPanelQResultDisplayStrategy): string | null {
  if (value === 'grid' || value === 'table' || value === 'qText' || value === 'text') {
    return panelQResultDisplayStrategy(value, fallback);
  }
  return null;
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

export function chartRangeIsZoomed(full: ChartRange | null | undefined, current: ChartRange | null | undefined): boolean {
  if (!full || !current ||
    !Number.isFinite(full.min) ||
    !Number.isFinite(full.max) ||
    !Number.isFinite(current.min) ||
    !Number.isFinite(current.max) ||
    full.max <= full.min ||
    current.max <= current.min) {
    return false;
  }

  const tolerance = Math.max(1e-9, Math.abs(full.max - full.min) * 1e-9);
  return Math.abs(current.min - full.min) > tolerance || Math.abs(current.max - full.max) > tolerance;
}

function chartSelectionStorageKey(columns: string[]): string {
  return `${CHART_SELECTION_STATE_PREFIX}${stableStringHash(chartColumnSignature(columns))}`;
}

function chartColumnSignature(columns: string[]): string {
  return JSON.stringify(columns.map(column => String(column || '')));
}

function stableStringHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeSavedChartSelection(value: any): SavedChartSelection | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const chartType = normalizeChartType(value.chartType);
  const xColumn = typeof value.xColumn === 'string' ? value.xColumn : '';
  const yColumns = uniqueChartColumnNames(Array.isArray(value.yColumns) ? value.yColumns.map(String) : []);
  const groupByColumn = typeof value.groupByColumn === 'string' ? value.groupByColumn : '';
  const openColumn = typeof value.openColumn === 'string' ? value.openColumn : '';
  const highColumn = typeof value.highColumn === 'string' ? value.highColumn : '';
  const lowColumn = typeof value.lowColumn === 'string' ? value.lowColumn : '';
  const closeColumn = typeof value.closeColumn === 'string' ? value.closeColumn : '';
  if (!xColumn) {
    return null;
  }
  if (chartType === 'candlestick') {
    const roles = [openColumn, highColumn, lowColumn, closeColumn];
    if (roles.some(column => !column) || new Set(roles).size !== roles.length) {
      return null;
    }
    return {
      chartType,
      xColumn,
      yColumns: [],
      openColumn,
      highColumn,
      lowColumn,
      closeColumn,
    };
  }
  if (yColumns.length === 0) {
    return null;
  }
  return {
    chartType,
    xColumn,
    yColumns,
    groupByColumn: chartType === 'box' ? undefined : (groupByColumn || undefined),
  };
}

function compatibleChartSelection(selection: SavedChartSelection, options: ReturnType<typeof chartColumnOptions>): SavedChartSelection | null {
  const xOption = options.xColumns.find(option => option.columnName === selection.xColumn);
  if (!xOption) {
    return null;
  }
  const chartType = normalizeChartType(selection.chartType);
  const yLookup = columnNameLookup(options.yColumns.map(option => option.columnName));
  if (chartType === 'candlestick') {
    const roles = [
      String(selection.openColumn || ''),
      String(selection.highColumn || ''),
      String(selection.lowColumn || ''),
      String(selection.closeColumn || ''),
    ];
    if (roles.some(column => !yLookup[column]) || new Set(roles).size !== roles.length) {
      return null;
    }
    return {
      chartType,
      xColumn: xOption.columnName,
      yColumns: [],
      openColumn: roles[0],
      highColumn: roles[1],
      lowColumn: roles[2],
      closeColumn: roles[3],
    };
  }
  const yColumns = uniqueChartColumnNames(selection.yColumns).filter(column => yLookup[column]);
  if (yColumns.length === 0) {
    return null;
  }
  const groupLookup = columnNameLookup(options.groupColumns.map(option => option.columnName));
  const groupByColumn = chartType === 'box' ? '' : (selection.groupByColumn && groupLookup[selection.groupByColumn]
    ? selection.groupByColumn
    : '');
  return {
    chartType,
    xColumn: xOption.columnName,
    yColumns,
    groupByColumn: groupByColumn || undefined,
  };
}

function uniqueChartColumnNames(values: string[]): string[] {
  const seen: { [value: string]: boolean } = Object.create(null);
  const result: string[] = [];
  values.forEach(value => {
    const text = String(value || '');
    if (text && !seen[text]) {
      seen[text] = true;
      result.push(text);
    }
  });
  return result;
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

function localDataServerEndpoint(value: any): LocalDataServerEndpoint {
  switch (value) {
    case 'metadata.json':
    case 'current.csv':
    case 'current.json':
    case 'current.ndjson':
    case 'slice.csv':
    case 'slice.json':
    case 'selection.csv':
    case 'selection.json':
      return value;
  }
  return 'current.csv';
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

function defaultTextExportUri(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : os.homedir();
  return vscode.Uri.file(path.join(folder, 'kdb-results.txt'));
}

function defaultChartExportUri(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : os.homedir();
  return vscode.Uri.file(path.join(folder, 'kdb-chart.png'));
}

function chartPngBytesFromDataUrl(value: any): Uint8Array {
  if (typeof value !== 'string' || !value.startsWith(CHART_PNG_DATA_URL_PREFIX)) {
    throw new Error('Chart export requires a PNG data URL.');
  }

  const base64 = value.slice(CHART_PNG_DATA_URL_PREFIX.length);
  if (base64.length === 0 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error('Invalid chart PNG data URL.');
  }

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const decodedBytes = base64.length / 4 * 3 - padding;
  if (decodedBytes > CHART_EXPORT_MAX_BYTES) {
    throw new Error(`Chart PNG export is too large: ${formatBytes(decodedBytes)}.`);
  }

  const content = Buffer.from(base64, 'base64');
  if (content.length < PNG_SIGNATURE.length) {
    throw new Error('Invalid chart PNG data.');
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index++) {
    if (content[index] !== PNG_SIGNATURE[index]) {
      throw new Error('Invalid chart PNG data.');
    }
  }
  return content;
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
  includeRowIndex: boolean,
  cellTextOptions: CellTextOptions = {}
): CopyExportEstimate {
  const shape = exportShape(range, { includeHeaders, includeRowIndex });
  const averageCellBytes = estimateAverageCellBytes(result, range, shape.selectedRows, shape.selectedColumns, cellTextOptions);
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
  estimate: CopyExportEstimate,
  confirmCellThreshold = COPY_EXPORT_CONFIRM_CELL_THRESHOLD
): string | undefined {
  if (
    estimate.selectedCells < confirmCellThreshold &&
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
  selectedColumns: number,
  cellTextOptions: CellTextOptions = {}
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
      sampledBytes += Buffer.byteLength(result.cellText(rowIndex, columnIndex, cellTextOptions), 'utf8');
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
  includeRowIndex: boolean,
  cellTextOptions: CellTextOptions = {}
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
  zip.file('xl/worksheets/sheet1.xml', sheetXml(result, range, includeHeaders, includeRowIndex, cellTextOptions));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

function sheetXml(
  result: ColumnarPanelResult,
  range: CellRange,
  includeHeaders: boolean,
  includeRowIndex: boolean,
  cellTextOptions: CellTextOptions
): string {
  const selectedRows = range.endRow - range.startRow + 1;
  const selectedColumns = range.endColumn - range.startColumn + 1 + (includeRowIndex ? 1 : 0);
  const outputRows = selectedRows + (includeHeaders ? 1 : 0);
  const dimension = `A1:${excelColumnName(selectedColumns - 1)}${Math.max(outputRows, 1)}`;
  return xmlDeclaration() +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="${dimension}"/>` +
    '<sheetData>' +
    sheetRowsXml(result, range, includeHeaders, includeRowIndex, cellTextOptions) +
    '</sheetData>' +
    '</worksheet>';
}

function sheetRowsXml(
  result: ColumnarPanelResult,
  range: CellRange,
  includeHeaders: boolean,
  includeRowIndex: boolean,
  cellTextOptions: CellTextOptions
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
      values.push(result.cellText(rowIndex, columnIndex, cellTextOptions));
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
