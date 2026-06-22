export interface CellPosition {
  row: number;
  column: number;
}

export interface CellRange {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

export interface VisibleIndexRange {
  start: number;
  end: number;
}

export interface CellWindow {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
  cells: string[][];
}

export type RowValue = { [key: string]: unknown };
export type TextExportFormat = 'tsv' | 'csv' | 'json' | 'ndjson' | 'html';
export type ExportFormat = TextExportFormat | 'xlsx' | 'parquet';

export function normalizeCellRange(anchor: CellPosition, focus: CellPosition): CellRange {
  return {
    startRow: Math.min(anchor.row, focus.row),
    endRow: Math.max(anchor.row, focus.row),
    startColumn: Math.min(anchor.column, focus.column),
    endColumn: Math.max(anchor.column, focus.column),
  };
}

export function isCellInRange(row: number, column: number, range: CellRange | null | undefined): boolean {
  return !!range &&
    row >= range.startRow &&
    row <= range.endRow &&
    column >= range.startColumn &&
    column <= range.endColumn;
}

export function clampCellRange(range: CellRange, rowCount: number, columnCount: number): CellRange | null {
  if (rowCount <= 0 || columnCount <= 0) {
    return null;
  }

  const maxRow = rowCount - 1;
  const maxColumn = columnCount - 1;
  const clamped = {
    startRow: clamp(range.startRow, 0, maxRow),
    endRow: clamp(range.endRow, 0, maxRow),
    startColumn: clamp(range.startColumn, 0, maxColumn),
    endColumn: clamp(range.endColumn, 0, maxColumn),
  };

  if (clamped.startRow > clamped.endRow || clamped.startColumn > clamped.endColumn) {
    return null;
  }

  return clamped;
}

export function allCellsRange(rowCount: number, columnCount: number): CellRange {
  return {
    startRow: 0,
    endRow: nonNegativeCount(rowCount) - 1,
    startColumn: 0,
    endColumn: nonNegativeCount(columnCount) - 1,
  };
}

export function rowsToTsv(rows: RowValue[], columns: string[], range: CellRange, includeHeaders = false): string {
  const clamped = clampCellRange(range, rows.length, columns.length);
  if (!clamped) {
    return '';
  }

  const lines: string[] = [];
  if (includeHeaders) {
    const headers: string[] = [];
    for (let columnIndex = clamped.startColumn; columnIndex <= clamped.endColumn; columnIndex++) {
      headers.push(cellValueToText(columns[columnIndex]));
    }
    lines.push(headers.join('\t'));
  }

  for (let rowIndex = clamped.startRow; rowIndex <= clamped.endRow; rowIndex++) {
    const row = rows[rowIndex] || {};
    const values: string[] = [];
    for (let columnIndex = clamped.startColumn; columnIndex <= clamped.endColumn; columnIndex++) {
      values.push(cellValueToText(row[columns[columnIndex]]));
    }
    lines.push(values.join('\t'));
  }
  return lines.join('\n');
}

export function rowsToCsv(rows: RowValue[], columns: string[], range: CellRange, includeHeaders = true): string {
  const clamped = clampCellRange(range, rows.length, columns.length);
  if (!clamped) {
    return '';
  }

  const lines: string[] = [];
  if (includeHeaders) {
    const headers: string[] = [];
    for (let columnIndex = clamped.startColumn; columnIndex <= clamped.endColumn; columnIndex++) {
      headers.push(escapeCsvCell(cellValueToExportText(columns[columnIndex])));
    }
    lines.push(headers.join(','));
  }

  for (let rowIndex = clamped.startRow; rowIndex <= clamped.endRow; rowIndex++) {
    const row = rows[rowIndex] || {};
    const values: string[] = [];
    for (let columnIndex = clamped.startColumn; columnIndex <= clamped.endColumn; columnIndex++) {
      values.push(escapeCsvCell(cellValueToExportText(row[columns[columnIndex]])));
    }
    lines.push(values.join(','));
  }
  return lines.join('\n');
}

export function rowsToJson(rows: RowValue[], columns: string[], range: CellRange): string {
  const clamped = clampCellRange(range, rows.length, columns.length);
  if (!clamped) {
    return '[]';
  }

  return stringifyJson(selectedRows(rows, columns, clamped));
}

export function rowsToNdjson(rows: RowValue[], columns: string[], range: CellRange): string {
  const clamped = clampCellRange(range, rows.length, columns.length);
  if (!clamped) {
    return '';
  }

  return selectedRows(rows, columns, clamped).map(row => stringifyJson(row)).join('\n');
}

export function rowsToHtml(rows: RowValue[], columns: string[], range: CellRange, includeHeaders = true): string {
  const clamped = clampCellRange(range, rows.length, columns.length);
  if (!clamped) {
    return '';
  }

  const parts: string[] = ['<table>'];
  if (includeHeaders) {
    parts.push('<thead><tr>');
    for (let columnIndex = clamped.startColumn; columnIndex <= clamped.endColumn; columnIndex++) {
      parts.push('<th>', escapeHtml(cellValueToExportText(columns[columnIndex])), '</th>');
    }
    parts.push('</tr></thead>');
  }

  parts.push('<tbody>');
  for (let rowIndex = clamped.startRow; rowIndex <= clamped.endRow; rowIndex++) {
    const row = rows[rowIndex] || {};
    parts.push('<tr>');
    for (let columnIndex = clamped.startColumn; columnIndex <= clamped.endColumn; columnIndex++) {
      parts.push('<td>', escapeHtml(cellValueToExportText(row[columns[columnIndex]])), '</td>');
    }
    parts.push('</tr>');
  }
  parts.push('</tbody></table>');
  return parts.join('');
}

export function rowsToTextFormat(
  rows: RowValue[],
  columns: string[],
  range: CellRange,
  format: TextExportFormat,
  includeHeaders = true
): string {
  switch (format) {
    case 'tsv':
      return rowsToTsv(rows, columns, range, includeHeaders);
    case 'csv':
      return rowsToCsv(rows, columns, range, includeHeaders);
    case 'json':
      return rowsToJson(rows, columns, range);
    case 'ndjson':
      return rowsToNdjson(rows, columns, range);
    case 'html':
      return rowsToHtml(rows, columns, range, includeHeaders);
  }

  throw new Error(`Unsupported text export format: ${format}`);
}

export function rowsToCellWindow(
  rows: RowValue[],
  columns: string[],
  rowRange: VisibleIndexRange,
  columnRange: VisibleIndexRange
): CellWindow {
  const clamped = clampCellRange(
    {
      startRow: rowRange.start,
      endRow: rowRange.end,
      startColumn: columnRange.start,
      endColumn: columnRange.end,
    },
    rows.length,
    columns.length
  );

  if (!clamped) {
    return emptyCellWindow();
  }

  const cells: string[][] = [];
  for (let rowIndex = clamped.startRow; rowIndex <= clamped.endRow; rowIndex++) {
    const row = rows[rowIndex] || {};
    const values: string[] = [];
    for (let columnIndex = clamped.startColumn; columnIndex <= clamped.endColumn; columnIndex++) {
      values.push(cellValueToText(row[columns[columnIndex]]));
    }
    cells.push(values);
  }

  return {
    startRow: clamped.startRow,
    endRow: clamped.endRow,
    startColumn: clamped.startColumn,
    endColumn: clamped.endColumn,
    cells,
  };
}

export function cellValueToText(value: unknown): string {
  return sanitizeTsvCell(cellValueToExportText(value));
}

export function visibleIndexRange(
  scrollOffset: number,
  viewportSize: number,
  itemSize: number,
  itemCount: number,
  overscan = 4
): VisibleIndexRange {
  if (itemCount <= 0 || itemSize <= 0 || viewportSize <= 0) {
    return { start: 0, end: -1 };
  }

  const safeOverscan = Math.max(0, Math.floor(overscan));
  const start = clamp(Math.floor(scrollOffset / itemSize) - safeOverscan, 0, itemCount - 1);
  const end = clamp(Math.ceil((scrollOffset + viewportSize) / itemSize) + safeOverscan, 0, itemCount - 1);
  return { start, end };
}

function cellValueToExportText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function selectedRows(rows: RowValue[], columns: string[], range: CellRange): RowValue[] {
  const selected: RowValue[] = [];
  for (let rowIndex = range.startRow; rowIndex <= range.endRow; rowIndex++) {
    const row = rows[rowIndex] || {};
    const value: RowValue = {};
    for (let columnIndex = range.startColumn; columnIndex <= range.endColumn; columnIndex++) {
      const column = columns[columnIndex];
      value[column] = row[column];
    }
    selected.push(value);
  }
  return selected;
}

function stringifyJson(value: unknown): string {
  const json = JSON.stringify(value, jsonReplacer);
  return json === undefined ? 'null' : json;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return String(value);
  }

  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return null;
  }

  return value;
}

function escapeCsvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return /[",\r\n]/.test(value) ? `"${escaped}"` : escaped;
}

function escapeHtml(value: string): string {
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
        return '&#39;';
    }
    return char;
  });
}

function sanitizeTsvCell(value: string): string {
  return value.replace(/\r\n|\r|\n|\t/g, ' ');
}

function emptyCellWindow(): CellWindow {
  return {
    startRow: 0,
    endRow: -1,
    startColumn: 0,
    endColumn: -1,
    cells: [],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(value), min), max);
}

function nonNegativeCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}
