import * as crypto from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import { URL } from 'url';
import {
  CellRange,
  CellTextOptions,
  ColumnarPanelResult,
  TextExportFormat,
  allCellsRange,
  clampCellRange,
} from './kdb-results';

export const LOCAL_DATA_SERVER_HOST = '127.0.0.1';
export const DEFAULT_LOCAL_DATA_SERVER_PORT = 7742;
export const LOCAL_DATA_SERVER_FULL_EXPORT_CELL_LIMIT = 1000000;
export const LOCAL_DATA_SERVER_SLICE_CELL_LIMIT = 1000000;
export const LOCAL_DATA_SERVER_PORT_SEARCH_LIMIT = 100;

export type LocalDataServerEndpoint =
  'metadata.json' |
  'current.csv' |
  'current.json' |
  'current.ndjson' |
  'slice.csv' |
  'slice.json' |
  'selection.csv' |
  'selection.json';

export interface LocalDataServerInfo {
  host: string;
  port: number;
  token: string;
  baseUrl: string;
}

export interface LocalDataServerSnapshot {
  metadata: any;
  table: ColumnarPanelResult;
  selectionRange?: CellRange;
  cellTextOptions?: CellTextOptions;
}

export interface LocalDataServerProvider {
  current(): LocalDataServerSnapshot | null;
}

export interface LocalDataServerOptions {
  fullExportCellLimit?: () => number;
  preferredPort?: number;
  provider: LocalDataServerProvider;
}

interface LocalDataServerRoute {
  endpoint: LocalDataServerEndpoint;
  params: URL['searchParams'];
}

interface HttpErrorResponse {
  status: number;
  code: string;
  message: string;
}

export class LocalDataServer {
  private readonly fullExportCellLimitValue: () => number;
  private readonly provider: LocalDataServerProvider;
  private readonly preferredPort: number;
  private server: http.Server | undefined;
  private infoValue: LocalDataServerInfo | undefined;

  public constructor(options: LocalDataServerOptions) {
    this.fullExportCellLimitValue = options.fullExportCellLimit || (() => LOCAL_DATA_SERVER_FULL_EXPORT_CELL_LIMIT);
    this.provider = options.provider;
    this.preferredPort = preferredPort(options.preferredPort);
  }

  public get info(): LocalDataServerInfo | undefined {
    return this.infoValue ? { ...this.infoValue } : undefined;
  }

  public get running(): boolean {
    return !!this.server && !!this.infoValue;
  }

  public endpointUrl(endpoint: LocalDataServerEndpoint): string | undefined {
    if (!this.infoValue) {
      return undefined;
    }
    return `${this.infoValue.baseUrl}/${endpoint}`;
  }

  public async start(): Promise<LocalDataServerInfo> {
    if (this.server && this.infoValue) {
      return { ...this.infoValue };
    }

    const token = randomLocalDataServerToken();
    const server = http.createServer((request, response) => this.handleRequest(request, response));
    this.server = server;
    try {
      const port = await listenOnNextFreePort(server, this.preferredPort);
      this.infoValue = {
        host: LOCAL_DATA_SERVER_HOST,
        port,
        token,
        baseUrl: `http://${LOCAL_DATA_SERVER_HOST}:${port}/${token}`,
      };
      return { ...this.infoValue };
    } catch (error) {
      this.server = undefined;
      this.infoValue = undefined;
      try {
        server.close();
      } catch {
        // Ignore close errors after a failed listen.
      }
      throw error;
    }
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.infoValue = undefined;
    if (!server) {
      return;
    }
    await closeServer(server);
  }

  private handleRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (request.method !== 'GET') {
      writeJson(response, 405, errorBody('method_not_allowed', 'Only GET is supported.'));
      return;
    }

    const parsed = parseRoute(request.url || '/', this.infoValue && this.infoValue.token);
    if (isHttpError(parsed)) {
      writeJson(response, parsed.status, errorBody(parsed.code, parsed.message));
      return;
    }

    const snapshot = this.provider.current();
    if (!snapshot) {
      writeJson(response, 400, errorBody('no_current_result', 'No current kdb panel result is available.'));
      return;
    }

    try {
      this.writeEndpoint(response, parsed, snapshot);
    } catch (error) {
      const httpError = toHttpError(error);
      writeJson(response, httpError.status, errorBody(httpError.code, httpError.message));
    }
  }

  private writeEndpoint(
    response: http.ServerResponse,
    route: LocalDataServerRoute,
    snapshot: LocalDataServerSnapshot
  ): void {
    switch (route.endpoint) {
      case 'metadata.json':
        writeJson(response, 200, metadataBody(snapshot, this.fullExportCellLimit()));
        return;
      case 'current.csv':
        writeTable(response, snapshot, allCellsRange(snapshot.table.rowCount, snapshot.table.columns.length), 'csv', true, this.fullExportCellLimit());
        return;
      case 'current.json':
        writeTable(response, snapshot, allCellsRange(snapshot.table.rowCount, snapshot.table.columns.length), 'json', true, this.fullExportCellLimit());
        return;
      case 'current.ndjson':
        writeTable(response, snapshot, allCellsRange(snapshot.table.rowCount, snapshot.table.columns.length), 'ndjson', true, this.fullExportCellLimit());
        return;
      case 'slice.csv':
        writeTable(response, snapshot, sliceRange(snapshot.table, route.params), 'csv', false, this.fullExportCellLimit());
        return;
      case 'slice.json':
        writeTable(response, snapshot, sliceRange(snapshot.table, route.params), 'json', false, this.fullExportCellLimit());
        return;
      case 'selection.csv':
        writeSelection(response, snapshot, 'csv', this.fullExportCellLimit());
        return;
      case 'selection.json':
        writeSelection(response, snapshot, 'json', this.fullExportCellLimit());
        return;
    }
  }

  private fullExportCellLimit(): number {
    return localDataServerFullExportCellLimitValue(this.fullExportCellLimitValue());
  }
}

export function randomLocalDataServerToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

function preferredPort(value: number | undefined): number {
  const port = Math.floor(Number(value || DEFAULT_LOCAL_DATA_SERVER_PORT));
  return port > 0 && port < 65536 ? port : DEFAULT_LOCAL_DATA_SERVER_PORT;
}

async function listenOnNextFreePort(server: http.Server, preferred: number): Promise<number> {
  for (let offset = 0; offset <= LOCAL_DATA_SERVER_PORT_SEARCH_LIMIT; offset++) {
    const port = preferred + offset;
    if (port >= 65536) {
      break;
    }
    try {
      await listen(server, port);
      const address = server.address() as AddressInfo | null;
      return address && typeof address.port === 'number' ? address.port : port;
    } catch (error) {
      if (!isPortBusyError(error)) {
        throw error;
      }
    }
  }
  throw new Error(`No free local data server port found from ${preferred}`);
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, LOCAL_DATA_SERVER_HOST);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error && (error as any).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function isPortBusyError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as any).code : '';
  return code === 'EADDRINUSE' || code === 'EACCES';
}

function parseRoute(rawUrl: string, token: string | undefined): LocalDataServerRoute | HttpErrorResponse {
  const parsed = new URL(rawUrl, `http://${LOCAL_DATA_SERVER_HOST}`);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || !token || parts[0] !== token) {
    return {
      status: 404,
      code: 'unknown_token',
      message: 'Unknown local data server token.',
    };
  }

  const endpoint = localDataServerEndpoint(parts[1]);
  if (!endpoint) {
    return {
      status: 404,
      code: 'unknown_endpoint',
      message: 'Unknown local data server endpoint.',
    };
  }

  return { endpoint, params: parsed.searchParams };
}

function localDataServerEndpoint(value: string): LocalDataServerEndpoint | null {
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
  return null;
}

function isHttpError(value: LocalDataServerRoute | HttpErrorResponse): value is HttpErrorResponse {
  return typeof (value as HttpErrorResponse).status === 'number';
}

export function localDataServerFullExportCellLimitValue(
  value: any,
  fallback = LOCAL_DATA_SERVER_FULL_EXPORT_CELL_LIMIT
): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  const integer = Math.floor(number);
  return integer >= 1 ? integer : fallback;
}

function metadataBody(snapshot: LocalDataServerSnapshot, fullExportCellLimit: number): any {
  return {
    ...snapshot.metadata,
    visibleColumns: snapshot.table.columns.slice(),
    rowCount: snapshot.table.rowCount,
    localDataServer: {
      endpoints: [
        'metadata.json',
        'current.csv',
        'current.json',
        'current.ndjson',
        'slice.csv',
        'slice.json',
        'selection.csv',
        'selection.json',
      ],
      fullExportCellLimit,
      sliceCellLimit: LOCAL_DATA_SERVER_SLICE_CELL_LIMIT,
    },
  };
}

function writeSelection(
  response: http.ServerResponse,
  snapshot: LocalDataServerSnapshot,
  format: TextExportFormat,
  fullExportCellLimit: number
): void {
  if (!snapshot.selectionRange) {
    writeJson(response, 400, errorBody('no_selection', 'No current webview selection has been sent to the extension.'));
    return;
  }
  const range = clampCellRange(snapshot.selectionRange, snapshot.table.rowCount, snapshot.table.columns.length);
  if (!range) {
    writeJson(response, 400, errorBody('empty_selection', 'The current webview selection is empty.'));
    return;
  }
  writeTable(response, snapshot, range, format, false, fullExportCellLimit);
}

function writeTable(
  response: http.ServerResponse,
  snapshot: LocalDataServerSnapshot,
  range: CellRange,
  format: TextExportFormat,
  fullExport: boolean,
  fullExportCellLimit: number
): void {
  const clamped = clampCellRange(range, snapshot.table.rowCount, snapshot.table.columns.length);
  const selectedCells = clamped
    ? (clamped.endRow - clamped.startRow + 1) * (clamped.endColumn - clamped.startColumn + 1)
    : 0;
  const limit = fullExport
    ? fullExportCellLimit
    : LOCAL_DATA_SERVER_SLICE_CELL_LIMIT;
  if (selectedCells > limit) {
    throw {
      status: fullExport ? 413 : 400,
      code: fullExport ? 'full_export_too_large' : 'slice_too_large',
      message: fullExport
        ? `Full export has ${selectedCells} visible cells; raise the local data server full-export cell limit or use slice endpoints for more than ${limit} cells.`
        : `Slice has ${selectedCells} visible cells; request at most ${limit} cells.`,
    };
  }

  const text = snapshot.table.toText(format, range, {
    includeHeaders: format === 'csv',
    includeRowIndex: false,
    arrayDisplayFormat: snapshot.cellTextOptions ? snapshot.cellTextOptions.arrayDisplayFormat : undefined,
  });
  writeText(response, 200, contentType(format), text);
}

function sliceRange(table: ColumnarPanelResult, params: URL['searchParams']): CellRange {
  const rowStart = queryInteger(params, 'rowStart', 0);
  const rowCount = queryInteger(params, 'rowCount', Math.min(1000, Math.max(1, table.rowCount)));
  const colStart = queryInteger(params, 'colStart', 0);
  const colCount = queryInteger(params, 'colCount', Math.min(20, Math.max(1, table.columns.length)));

  if (rowStart < 0 || rowCount < 1 || colStart < 0 || colCount < 1) {
    throw {
      status: 400,
      code: 'invalid_slice',
      message: 'rowStart and colStart must be non-negative; rowCount and colCount must be positive.',
    };
  }

  if (rowCount * colCount > LOCAL_DATA_SERVER_SLICE_CELL_LIMIT) {
    throw {
      status: 400,
      code: 'slice_too_large',
      message: `Slice requests are limited to ${LOCAL_DATA_SERVER_SLICE_CELL_LIMIT} cells.`,
    };
  }

  if (table.rowCount > 0 && rowStart >= table.rowCount) {
    throw {
      status: 400,
      code: 'invalid_slice',
      message: `rowStart ${rowStart} is outside ${table.rowCount} rows.`,
    };
  }

  if (table.columns.length > 0 && colStart >= table.columns.length) {
    throw {
      status: 400,
      code: 'invalid_slice',
      message: `colStart ${colStart} is outside ${table.columns.length} columns.`,
    };
  }

  return {
    startRow: rowStart,
    endRow: table.rowCount <= 0 ? -1 : Math.min(table.rowCount - 1, rowStart + rowCount - 1),
    startColumn: colStart,
    endColumn: table.columns.length <= 0 ? -1 : Math.min(table.columns.length - 1, colStart + colCount - 1),
  };
}

function queryInteger(params: URL['searchParams'], key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null || raw === '') {
    return fallback;
  }
  const number = Number(raw);
  if (!Number.isFinite(number) || Math.floor(number) !== number) {
    throw {
      status: 400,
      code: 'invalid_slice',
      message: `${key} must be an integer.`,
    };
  }
  return number;
}

function contentType(format: TextExportFormat): string {
  switch (format) {
    case 'csv':
      return 'text/csv; charset=utf-8';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'ndjson':
      return 'application/x-ndjson; charset=utf-8';
    case 'html':
      return 'text/html; charset=utf-8';
    case 'markdown':
      return 'text/markdown; charset=utf-8';
    case 'tsv':
      return 'text/tab-separated-values; charset=utf-8';
  }
}

function toHttpError(error: unknown): HttpErrorResponse {
  if (error && typeof error === 'object') {
    const status = Number((error as any).status);
    const code = typeof (error as any).code === 'string' ? (error as any).code : 'request_failed';
    const message = typeof (error as any).message === 'string' ? (error as any).message : String(error);
    if (Number.isFinite(status)) {
      return { status, code, message };
    }
  }
  return {
    status: 500,
    code: 'request_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

function errorBody(code: string, message: string): any {
  return { error: { code, message } };
}

function writeJson(response: http.ServerResponse, status: number, value: any): void {
  writeText(response, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function writeText(response: http.ServerResponse, status: number, contentTypeValue: string, text: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', contentTypeValue);
  response.setHeader('Cache-Control', 'no-store');
  response.end(text);
}
