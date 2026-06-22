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

export type RowValue = { [key: string]: unknown };

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

export function rowsToTsv(rows: RowValue[], columns: string[], range: CellRange): string {
  const clamped = clampCellRange(range, rows.length, columns.length);
  if (!clamped) {
    return '';
  }

  const lines: string[] = [];
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

export function cellValueToText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return sanitizeTsvCell(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  try {
    return sanitizeTsvCell(JSON.stringify(value));
  } catch {
    return sanitizeTsvCell(String(value));
  }
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

function sanitizeTsvCell(value: string): string {
  return value.replace(/\r\n|\r|\n|\t/g, ' ');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(value), min), max);
}
