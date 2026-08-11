export const HEADER_REORDER_THRESHOLD_CSS_PIXELS = 5;

export type ResultTableSortDirection = 'asc' | 'desc';

export interface ResultTableSortState<Key = string> {
  column: Key;
  direction: ResultTableSortDirection;
}

/** Portable result ordering: null-like empty values last, then booleans,
 * exact integers, finite numbers, and finally locale-natural text. */
export function compareResultCellText(
  left: string,
  right: string,
  direction: ResultTableSortDirection = 'asc'
): number {
  const leftText = String(left);
  const rightText = String(right);
  const leftEmpty = leftText.trim().length === 0;
  const rightEmpty = rightText.trim().length === 0;
  if (leftEmpty || rightEmpty) {
    if (leftEmpty && rightEmpty) return 0;
    return leftEmpty ? 1 : -1;
  }

  const compared = compareNonEmptyResultCellText(leftText, rightText);
  return direction === 'desc' ? -compared : compared;
}

function compareNonEmptyResultCellText(left: string, right: string): number {
  const leftBoolean = booleanResultSortValue(left);
  const rightBoolean = booleanResultSortValue(right);
  if (leftBoolean !== null && rightBoolean !== null) {
    return leftBoolean - rightBoolean;
  }

  const leftNumber = numericResultSortValue(left);
  const rightNumber = numericResultSortValue(right);
  const leftInteger = integerResultSortValue(left);
  const rightInteger = integerResultSortValue(right);
  if (leftInteger !== null && rightInteger !== null) {
    return leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0;
  }
  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }

  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function integerResultSortValue(value: string): bigint | null {
  const normalized = value.trim();
  if (!/^[+-]?\d+$/.test(normalized)) {
    return null;
  }
  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

function booleanResultSortValue(value: string): number | null {
  const normalized = value.trim().toLocaleLowerCase();
  return normalized === 'false' ? 0 : normalized === 'true' ? 1 : null;
}

function numericResultSortValue(value: string): number | null {
  const normalized = value.trim();
  if (!/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(normalized)) {
    return null;
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

export interface HeaderPointerState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  sourceColumn: number;
  targetColumn: number;
  reorder: boolean;
}

export type HeaderPointerIntent = 'sort' | 'select' | 'reorder';

export interface ResultTableCellSelection {
  anchorRow: number;
  anchorColumn: number;
  focusRow: number;
  focusColumn: number;
}

export function nextResultTableSortState<Key>(
  current: ResultTableSortState<Key> | null | undefined,
  column: Key
): ResultTableSortState<Key> | undefined {
  if (!current || current.column !== column) {
    return { column, direction: 'asc' };
  }
  if (current.direction === 'asc') {
    return { column, direction: 'desc' };
  }
  return undefined;
}

export function beginHeaderPointer(
  sourceColumn: number,
  clientX: number,
  clientY: number
): HeaderPointerState {
  const x = Number.isFinite(clientX) ? clientX : 0;
  const y = Number.isFinite(clientY) ? clientY : 0;
  return {
    startX: x,
    startY: y,
    currentX: x,
    currentY: y,
    sourceColumn,
    targetColumn: sourceColumn,
    reorder: false,
  };
}

export function updateHeaderPointer(
  state: HeaderPointerState,
  clientX: number,
  clientY: number,
  targetColumn = state.targetColumn,
  threshold = 5
): HeaderPointerState {
  const currentX = Number.isFinite(clientX) ? clientX : 0;
  const currentY = Number.isFinite(clientY) ? clientY : 0;
  const distance = Math.hypot(currentX - state.startX, currentY - state.startY);
  return {
    ...state,
    currentX,
    currentY,
    targetColumn,
    reorder: state.reorder || distance >= Math.max(0, threshold),
  };
}

export function headerPointerIntent(
  state: HeaderPointerState,
  columnSelectionModifier: boolean,
  _extendSelection = false
): HeaderPointerIntent {
  if (state.reorder) {
    return 'reorder';
  }
  // Shift extends a whole-column selection only together with Ctrl/Cmd.
  // Shift alone keeps the normal tri-state sort activation.
  return columnSelectionModifier ? 'select' : 'sort';
}

export function moveResultColumn<T>(
  order: readonly T[],
  sourceColumn: number,
  targetColumn: number
): T[] {
  if (!Number.isSafeInteger(sourceColumn) || !Number.isSafeInteger(targetColumn) ||
    sourceColumn < 0 || targetColumn < 0 || sourceColumn >= order.length ||
    targetColumn >= order.length || sourceColumn === targetColumn) {
    return order.slice();
  }
  const next = order.slice();
  const moved = next.splice(sourceColumn, 1)[0];
  next.splice(targetColumn, 0, moved);
  return next;
}

export function moveResultColumnBy(
  columnCount: number,
  focusedColumn: number,
  delta: number
): { sourceColumn: number; targetColumn: number } | null {
  if (!Number.isSafeInteger(columnCount) || columnCount < 1 ||
    !Number.isSafeInteger(focusedColumn) || focusedColumn < 0 ||
    focusedColumn >= columnCount || !Number.isFinite(delta)) {
    return null;
  }
  const targetColumn = Math.min(
    columnCount - 1,
    Math.max(0, focusedColumn + Math.sign(delta))
  );
  return targetColumn === focusedColumn
    ? null
    : { sourceColumn: focusedColumn, targetColumn };
}

export function fullResultColumnSelection(
  previous: ResultTableCellSelection | undefined,
  displayColumn: number,
  rowCount: number,
  extend: boolean
): ResultTableCellSelection | undefined {
  if (!Number.isSafeInteger(displayColumn) || displayColumn < 0 ||
    !Number.isSafeInteger(rowCount) || rowCount < 1) {
    return undefined;
  }
  return extend && previous
    ? {
      anchorRow: 0,
      anchorColumn: previous.anchorColumn,
      focusRow: rowCount - 1,
      focusColumn: displayColumn,
    }
    : {
      anchorRow: 0,
      anchorColumn: displayColumn,
      focusRow: rowCount - 1,
      focusColumn: displayColumn,
    };
}

export function resultTableAriaSort(
  sorted: boolean,
  direction: ResultTableSortDirection | undefined
): 'none' | 'ascending' | 'descending' {
  return !sorted ? 'none' : direction === 'desc' ? 'descending' : 'ascending';
}

export function resultTableSortIndicator(
  sorted: boolean,
  direction: ResultTableSortDirection | undefined
): '' | '▲' | '▼' {
  return !sorted ? '' : direction === 'desc' ? '▼' : '▲';
}

export function resultTableHeaderAriaLabel(
  columnName: string,
  displayColumn: number,
  columnCount: number,
  sorted: boolean,
  direction: ResultTableSortDirection | undefined
): string {
  const position = Math.min(
    Math.max(1, Math.floor(Number(displayColumn) || 0) + 1),
    Math.max(1, Math.floor(Number(columnCount) || 0))
  );
  const count = Math.max(1, Math.floor(Number(columnCount) || 0));
  const sortState = !sorted
    ? 'not sorted'
    : direction === 'desc'
      ? 'sorted descending'
      : 'sorted ascending';
  return `${String(columnName)}, column ${position} of ${count}, ${sortState}; ` +
    'click to sort, drag to reorder, Control or Command click to select column';
}

export function absoluteDisplayRowClass(rowIndex: number): 'row-even' | 'row-odd' {
  return Math.max(0, Math.floor(Number(rowIndex) || 0)) % 2 === 0
    ? 'row-even'
    : 'row-odd';
}
