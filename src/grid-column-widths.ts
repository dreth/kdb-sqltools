import {
  CellTextOptions,
  CellWindow,
  ColumnarPanelResult,
} from './kdb-results';

export type GridAutoFitMode = 'wholeResult' | 'visibleRows';
export interface PositionalColumnWidths {
  [position: string]: number;
}

export const GRID_COLUMN_WIDTH_MIN = 80;
export const GRID_COLUMN_WIDTH_MAX = 2000;

export class PositionalColumnWidthPersistenceQueue {
  private pendingWrite: Promise<void> = Promise.resolve();

  public constructor(
    private readonly read: () => unknown | PromiseLike<unknown>,
    private readonly write: (widths: PositionalColumnWidths) => void | PromiseLike<void>,
    private readonly minWidth = GRID_COLUMN_WIDTH_MIN,
    private readonly maxWidth = GRID_COLUMN_WIDTH_MAX
  ) {}

  public update(
    transform: (current: PositionalColumnWidths) => unknown,
    afterWrite?: (widths: PositionalColumnWidths) => void | PromiseLike<void>
  ): Promise<PositionalColumnWidths> {
    const operation = this.pendingWrite.then(async () => {
      const current = normalizePositionalColumnWidths(
        await this.read(),
        this.minWidth,
        this.maxWidth
      );
      const next = normalizePositionalColumnWidths(
        transform({ ...current }),
        this.minWidth,
        this.maxWidth
      );
      await this.write(next);
      if (afterWrite) {
        await afterWrite(next);
      }
      return next;
    });
    this.pendingWrite = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }
}

export function normalizeGridAutoFitMode(value: unknown): GridAutoFitMode {
  return value === 'visibleRows' ? 'visibleRows' : 'wholeResult';
}

/**
 * Normalizes persisted widths without attaching them to a query or column name.
 * Only canonical nonnegative integer keys are retained.
 */
export function normalizePositionalColumnWidths(
  value: unknown,
  minWidth = 80,
  maxWidth = 2000
): PositionalColumnWidths {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const min = Number.isFinite(minWidth) ? Math.floor(minWidth) : 80;
  const max = Number.isFinite(maxWidth) ? Math.max(min, Math.floor(maxWidth)) : 2000;
  const widths: PositionalColumnWidths = {};
  const source: { [position: string]: unknown } = Array.isArray(value)
    ? value.reduce((mapped: { [position: string]: unknown }, item, index) => {
      if (item !== null && item !== undefined) {
        mapped[String(index)] = item;
      }
      return mapped;
    }, {})
    : (value && typeof value === 'object' ? value as { [position: string]: unknown } : {});
  Object.keys(source).forEach(key => {
    if (!/^(0|[1-9]\d*)$/.test(key)) {
      return;
    }
    const rawWidth = source[key];
    if (rawWidth === null || rawWidth === undefined || typeof rawWidth === 'boolean' || rawWidth === '') {
      return;
    }
    const width = Number(rawWidth);
    if (Number.isFinite(width)) {
      widths[key] = Math.min(Math.max(Math.floor(width), min), max);
    }
  });
  return widths;
}

export function positionalColumnWidthEntries(value: unknown): Array<[number, number]> {
  const widths = normalizePositionalColumnWidths(value);
  return Object.keys(widths)
    .map(key => [Number(key), widths[key]] as [number, number])
    .sort((left, right) => left[0] - right[0]);
}

export function hasPositionalColumnWidths(value: unknown): boolean {
  return Object.keys(normalizePositionalColumnWidths(value)).length > 0;
}

export function sourceColumnPositions(
  sourceColumns: readonly string[],
  visibleColumns: readonly string[]
): number[] {
  const used: { [position: number]: boolean } = Object.create(null);
  return visibleColumns.map((column, visiblePosition) => {
    const sourcePosition = sourceColumns.findIndex((candidate, position) => {
      return candidate === column && !used[position];
    });
    const position = sourcePosition >= 0 ? sourcePosition : visiblePosition;
    used[position] = true;
    return position;
  });
}

function canonicalPosition(value: unknown): string | null {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.floor(number) !== number || number < 0) {
    return null;
  }
  return String(number);
}

export function updatePositionalColumnWidth(
  value: unknown,
  position: unknown,
  width: unknown,
  minWidth = 80,
  maxWidth = 2000
): PositionalColumnWidths {
  const widths = normalizePositionalColumnWidths(value, minWidth, maxWidth);
  const key = canonicalPosition(position);
  if (key === null) {
    return widths;
  }

  if (width === null || width === undefined) {
    delete widths[key];
  } else {
    const normalized = normalizePositionalColumnWidths({ [key]: width }, minWidth, maxWidth);
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      widths[key] = normalized[key];
    } else {
      delete widths[key];
    }
  }
  return widths;
}

export function resolvedPositionalColumnWidth(
  position: unknown,
  fallbackWidth: unknown,
  manualWidths: unknown,
  autoFitEnabled: boolean,
  autoWidths: unknown,
  minWidth = 80,
  maxWidth = 2000
): number {
  const min = Number.isFinite(minWidth) ? Math.floor(minWidth) : 80;
  const max = Number.isFinite(maxWidth) ? Math.max(min, Math.floor(maxWidth)) : 2000;
  const clamp = (candidate: unknown, fallback: number): number => {
    const number = Number(candidate);
    return Number.isFinite(number)
      ? Math.min(Math.max(Math.floor(number), min), max)
      : fallback;
  };
  const fallback = clamp(fallbackWidth, min);
  const index = Number(position);
  if (!Number.isFinite(index) || Math.floor(index) !== index || index < 0) {
    return fallback;
  }
  const manual = manualWidths && typeof manualWidths === 'object'
    ? (manualWidths as { [position: string]: unknown })[String(index)]
    : undefined;
  if (manual !== null && manual !== undefined && Number.isFinite(Number(manual))) {
    return clamp(manual, fallback);
  }
  const automatic = autoWidths && typeof autoWidths === 'object'
    ? (autoWidths as { [position: string]: unknown })[String(index)]
    : undefined;
  return autoFitEnabled && automatic !== null && automatic !== undefined && Number.isFinite(Number(automatic))
    ? clamp(automatic, fallback)
    : fallback;
}

export function wholeResultColumnTextLengths(
  table: ColumnarPanelResult,
  options?: CellTextOptions
): number[] {
  const lengths = table.columns.map(column => String(column || '').length);
  for (let rowIndex = 0; rowIndex < table.rowCount; rowIndex++) {
    for (let columnIndex = 0; columnIndex < table.columns.length; columnIndex++) {
      lengths[columnIndex] = Math.max(
        lengths[columnIndex],
        table.cellText(rowIndex, columnIndex, options).length
      );
    }
  }
  return lengths;
}

export function visibleRowsColumnTextLengths(columns: string[], slice: CellWindow): number[] {
  const lengths = columns.map(column => String(column || '').length);
  if (!slice || slice.endColumn < slice.startColumn) {
    return lengths;
  }
  for (let columnIndex = slice.startColumn; columnIndex <= slice.endColumn; columnIndex++) {
    if (columnIndex < 0 || columnIndex >= lengths.length) {
      continue;
    }
    for (let rowOffset = 0; rowOffset < slice.cells.length; rowOffset++) {
      const row = slice.cells[rowOffset] || [];
      const text = row[columnIndex - slice.startColumn];
      lengths[columnIndex] = Math.max(lengths[columnIndex], String(text || '').length);
    }
  }
  return lengths;
}
