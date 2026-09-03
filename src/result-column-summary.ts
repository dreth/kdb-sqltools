import { cellValueToText, ColumnarPanelResult } from './kdb-results';

export const KDB_COLUMN_SUMMARY_SCHEMA_VERSION = 1 as const;
export const KDB_COLUMN_SUMMARY_EXACT_MAX_ROWS = 50_000;
export const KDB_COLUMN_SUMMARY_MAX_EVALUATED_CELLS = 100_000;
export const KDB_COLUMN_SUMMARY_SAMPLE_MAX_ROWS = 10_000;
export const KDB_COLUMN_SUMMARY_FREQUENT_VALUE_LIMIT = 5;
export const KDB_COLUMN_SUMMARY_VALUE_MAX_CHARS = 160;
export const KDB_COLUMN_SUMMARY_DEFAULT_YIELD_CELLS = 4_096;

export interface KdbColumnSummaryValue {
  text: string;
  truncated: boolean;
  derived?: boolean;
  approximate?: boolean;
}

export interface KdbColumnSummaryFrequentValue extends KdbColumnSummaryValue { count: number; }

export interface KdbColumnSummary {
  sourceColumnPosition: number;
  columnName: string;
  kind: 'numeric' | 'temporal' | 'text' | 'other';
  totalRowCount: number;
  evaluatedRowCount: number;
  validCount: number;
  nullCount: number;
  distinctCount: number;
  distinctComplete: boolean;
  metricValueCount: number;
  metricsComplete: boolean;
  min?: KdbColumnSummaryValue;
  max?: KdbColumnSummaryValue;
  mean?: KdbColumnSummaryValue;
  median?: KdbColumnSummaryValue;
  frequentValues?: KdbColumnSummaryFrequentValue[];
}

export interface KdbColumnSummaryBatch {
  schemaVersion: typeof KDB_COLUMN_SUMMARY_SCHEMA_VERSION;
  mode: 'exact' | 'sampled';
  algorithm: 'allRows' | 'evenlySpacedRows';
  totalRowCount: number;
  evaluatedRowCount: number;
  evaluatedCellCount: number;
  columnCount: number;
  endpointsIncluded: boolean;
  columns: KdbColumnSummary[];
}

export interface ComputeResultColumnSummariesOptions {
  shouldCancel?: () => boolean;
  signal?: { readonly aborted: boolean };
  yieldEveryCells?: number;
  yieldControl?: () => void | Promise<void>;
}

export function evenlySpacedRowIndexes(totalRowCount: number, count: number): number[] {
  const total = Math.max(0, Math.floor(totalRowCount));
  const wanted = Math.max(0, Math.min(total, Math.floor(count)));
  if (wanted === 0) return [];
  if (wanted === total) return Array.from({ length: total }, (_value, index) => index);
  if (wanted === 1) return [0];
  const indexes: number[] = [];
  for (let index = 0; index < wanted; index += 1) {
    indexes.push(Math.round(index * (total - 1) / (wanted - 1)));
  }
  return indexes;
}

export function planResultColumnSummaries(result: ColumnarPanelResult): {
  mode: 'exact' | 'sampled'; algorithm: 'allRows' | 'evenlySpacedRows'; rowIndexes: number[];
  totalRowCount: number; columnCount: number; evaluatedRowCount: number;
  evaluatedCellCount: number; endpointsIncluded: boolean;
} {
  const rows = Math.max(0, result.rowCount);
  const columns = Math.max(0, result.columns.length);
  const budgetRows = columns === 0 ? 0 : Math.floor(KDB_COLUMN_SUMMARY_MAX_EVALUATED_CELLS / columns);
  const count = Math.min(rows, KDB_COLUMN_SUMMARY_SAMPLE_MAX_ROWS, Math.max(0, budgetRows));
  const exact = rows <= KDB_COLUMN_SUMMARY_EXACT_MAX_ROWS && count === rows;
  const rowIndexes = exact ? evenlySpacedRowIndexes(rows, rows) : evenlySpacedRowIndexes(rows, count);
  return {
    mode: exact ? 'exact' : 'sampled',
    algorithm: exact ? 'allRows' : 'evenlySpacedRows',
    rowIndexes,
    totalRowCount: rows,
    columnCount: columns,
    evaluatedRowCount: rowIndexes.length,
    evaluatedCellCount: rowIndexes.length * columns,
    endpointsIncluded: rows === 0 || rowIndexes.length > 1 || rowIndexes[0] === 0,
  };
}

export async function computeResultColumnSummaries(
  result: ColumnarPanelResult,
  options: ComputeResultColumnSummariesOptions = {}
): Promise<KdbColumnSummaryBatch | undefined> {
  const plan = planResultColumnSummaries(result);
  const yieldEvery = Math.max(1, Math.floor(options.yieldEveryCells || KDB_COLUMN_SUMMARY_DEFAULT_YIELD_CELLS));
  const yieldControl = options.yieldControl || (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  const cancelled = (): boolean => !!options.signal?.aborted || !!options.shouldCancel?.();
  const columns: KdbColumnSummary[] = [];
  let evaluatedCells = 0;
  for (let columnIndex = 0; columnIndex < result.columns.length; columnIndex += 1) {
    const values: unknown[] = [];
    for (const rowIndex of plan.rowIndexes) {
      if (cancelled()) return undefined;
      values.push(result.cellValue(rowIndex, columnIndex));
      evaluatedCells += 1;
      if (evaluatedCells % yieldEvery === 0) await yieldControl();
    }
    columns.push(summarizeColumn(result.columns[columnIndex], columnIndex, result.rowCount, values, plan.mode === 'exact'));
  }
  if (cancelled()) return undefined;
  return {
    schemaVersion: KDB_COLUMN_SUMMARY_SCHEMA_VERSION,
    mode: plan.mode,
    algorithm: plan.algorithm,
    totalRowCount: plan.totalRowCount,
    evaluatedRowCount: plan.evaluatedRowCount,
    evaluatedCellCount: evaluatedCells,
    columnCount: plan.columnCount,
    endpointsIncluded: plan.endpointsIncluded,
    columns,
  };
}

function summarizeColumn(name: string, position: number, totalRows: number, values: unknown[], exact: boolean): KdbColumnSummary {
  const valid = values.filter(value => !isNullLike(value));
  const kind = inferKind(valid);
  const counts = new Map<string, { value: unknown; count: number; first: number }>();
  valid.forEach((value, index) => {
    const key = stableValueKey(value);
    const found = counts.get(key);
    if (found) found.count += 1;
    else counts.set(key, { value, count: 1, first: index });
  });
  const metricValues = kind === 'numeric'
    ? valid.map(value => Number(value)).filter(Number.isFinite)
    : kind === 'temporal'
      ? valid.map(temporalNumber).filter((value): value is number => value !== null && Number.isFinite(value))
      : [];
  metricValues.sort((left, right) => left - right);
  const summary: KdbColumnSummary = {
    sourceColumnPosition: position,
    columnName: name,
    kind,
    totalRowCount: totalRows,
    evaluatedRowCount: values.length,
    validCount: valid.length,
    nullCount: values.length - valid.length,
    distinctCount: counts.size,
    distinctComplete: exact,
    metricValueCount: metricValues.length,
    metricsComplete: kind === 'numeric' || kind === 'temporal' ? metricValues.length === valid.length : true,
  };
  if (metricValues.length > 0) {
    summary.min = summaryValue(kind === 'temporal' ? new Date(metricValues[0]).toISOString() : String(metricValues[0]), false, true);
    summary.max = summaryValue(kind === 'temporal' ? new Date(metricValues[metricValues.length - 1]).toISOString() : String(metricValues[metricValues.length - 1]), false, true);
    if (kind === 'numeric') {
      const mean = metricValues.reduce((sum, value) => sum + value, 0) / metricValues.length;
      const middle = Math.floor(metricValues.length / 2);
      const median = metricValues.length % 2 ? metricValues[middle] : (metricValues[middle - 1] + metricValues[middle]) / 2;
      summary.mean = summaryValue(String(mean), false, true);
      summary.median = summaryValue(String(median), false, true);
    }
  }
  summary.frequentValues = Array.from(counts.values())
    .sort((left, right) => right.count - left.count || left.first - right.first)
    .slice(0, KDB_COLUMN_SUMMARY_FREQUENT_VALUE_LIMIT)
    .map(item => ({ ...summaryValue(cellValueToText(item.value), false), count: item.count }));
  return summary;
}

function summaryValue(text: string, approximate: boolean, derived = false): KdbColumnSummaryValue {
  const truncated = text.length > KDB_COLUMN_SUMMARY_VALUE_MAX_CHARS;
  return {
    text: truncated ? text.slice(0, KDB_COLUMN_SUMMARY_VALUE_MAX_CHARS - 1) + '…' : text,
    truncated,
    derived: derived || undefined,
    approximate: approximate || undefined,
  };
}

function inferKind(values: unknown[]): KdbColumnSummary['kind'] {
  if (values.length === 0) return 'other';
  if (values.every(value => typeof value === 'number' || typeof value === 'bigint')) return 'numeric';
  if (values.every(value => temporalNumber(value) !== null)) return 'temporal';
  if (values.every(value => typeof value === 'string' || typeof value === 'boolean')) return 'text';
  return 'other';
}

function temporalNumber(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== 'string' || !/^\d{4}[.-]\d{2}/.test(value.trim())) return null;
  const parsed = Date.parse(value.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3').replace('D', 'T'));
  return Number.isFinite(parsed) ? parsed : null;
}

function isNullLike(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value));
}

function stableValueKey(value: unknown): string {
  if (value instanceof Date) return 'date:' + value.toISOString();
  if (typeof value === 'bigint') return 'bigint:' + value.toString();
  if (value && typeof value === 'object') {
    try { return 'object:' + JSON.stringify(value); } catch (_error) { return 'object:' + cellValueToText(value); }
  }
  return typeof value + ':' + String(value);
}
