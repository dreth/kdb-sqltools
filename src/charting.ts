import { ColumnarPanelResult } from './kdb-results';

export type ChartColumnKind = 'numeric' | 'temporal';

export interface ChartColumnOption {
  columnName: string;
  columnIndex: number;
  kind: ChartColumnKind;
}

export interface ChartColumnOptions {
  xColumns: ChartColumnOption[];
  yColumns: ChartColumnOption[];
  warnings: string[];
}

export interface LineChartRequest {
  xColumn: string;
  yColumns: string[];
  width: number;
  version: number;
  requestId: number;
  maxSourceRows?: number;
  maxSampledPoints?: number;
}

export interface LineChartSeries {
  columnName: string;
  values: Array<number | null>;
}

export interface LineChartData {
  version: number;
  requestId: number;
  xColumn: string;
  xKind: ChartColumnKind;
  x: number[];
  xText: string[];
  series: LineChartSeries[];
  sourceRowCount: number;
  eligibleRowCount: number;
  sampledPointCount: number;
  algorithm: string;
  sorted: boolean;
  warnings: string[];
}

interface ChartPoint {
  rowIndex: number;
  x: number;
  xText: string;
  y: Array<number | null>;
}

interface NormalizedValue {
  value: number;
  text: string;
}

interface ColumnInference {
  numeric: boolean;
  temporal: boolean;
  sampled: number;
  missing: number;
  invalid: number;
}

export class ChartDataError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ChartDataError';
    Object.setPrototypeOf(this, ChartDataError.prototype);
  }
}

export const CHART_INFERENCE_SAMPLE_SIZE = 200;
export const CHART_MAX_SOURCE_ROWS = 2000000;
export const CHART_MAX_SAMPLED_POINTS = 12000;
export const CHART_POINTS_PER_PIXEL = 3;

export function chartColumnOptions(table: ColumnarPanelResult, sampleSize = CHART_INFERENCE_SAMPLE_SIZE): ChartColumnOptions {
  const xColumns: ChartColumnOption[] = [];
  const yColumns: ChartColumnOption[] = [];
  const warnings: string[] = [];

  table.columns.forEach((columnName, columnIndex) => {
    const inference = inferColumn(table, columnIndex, sampleSize);
    if (inference.numeric) {
      xColumns.push({ columnName, columnIndex, kind: 'numeric' });
      yColumns.push({ columnName, columnIndex, kind: 'numeric' });
    } else if (inference.temporal) {
      xColumns.push({ columnName, columnIndex, kind: 'temporal' });
    }

    if (inference.sampled === 0 && table.rowCount > 0) {
      warnings.push(`${columnName} has no sampled scalar values.`);
    }
  });

  if (xColumns.length === 0) {
    warnings.push('No numeric or temporal x columns were detected in the visible columns.');
  }
  if (yColumns.length === 0) {
    warnings.push('No numeric y columns were detected in the visible columns.');
  }

  return { xColumns, yColumns, warnings };
}

export function buildLineChartData(table: ColumnarPanelResult, request: LineChartRequest): LineChartData {
  const maxSourceRows = positiveInteger(request.maxSourceRows, CHART_MAX_SOURCE_ROWS);
  if (table.rowCount > maxSourceRows) {
    throw new ChartDataError(`Chart source has ${table.rowCount} rows; limit the q result or use the local data server for sources above ${maxSourceRows} rows.`);
  }
  const raisedSourceRowLimit = maxSourceRows > CHART_MAX_SOURCE_ROWS && table.rowCount > CHART_MAX_SOURCE_ROWS;

  const xColumnIndex = table.columns.indexOf(request.xColumn);
  if (xColumnIndex === -1) {
    throw new ChartDataError(`Chart x column not found: ${request.xColumn}`);
  }

  const options = chartColumnOptions(table);
  const xOption = options.xColumns.filter(option => option.columnName === request.xColumn)[0];
  if (!xOption) {
    throw new ChartDataError(`${request.xColumn} is not eligible as a numeric or temporal x column.`);
  }

  const yColumnNames = uniqueStrings(request.yColumns);
  if (yColumnNames.length === 0) {
    throw new ChartDataError('Select at least one numeric y column.');
  }

  const yOptionsByName = optionLookup(options.yColumns);
  const yColumnIndexes: number[] = [];
  yColumnNames.forEach(columnName => {
    const option = yOptionsByName[columnName];
    if (!option) {
      throw new ChartDataError(`${columnName} is not eligible as a numeric y column.`);
    }
    yColumnIndexes.push(option.columnIndex);
  });

  const warnings = options.warnings.slice();
  if (raisedSourceRowLimit) {
    warnings.push('Chart source exceeds the default row guard. Very large chartMaxSourceRows values can make rendering slow or temporarily block the extension host, especially with multiple y columns.');
  }
  const points: ChartPoint[] = [];
  let droppedX = 0;
  let yMissing = 0;
  let yInvalid = 0;
  for (let rowIndex = 0; rowIndex < table.rowCount; rowIndex++) {
    const x = normalizeXValue(table.cellValue(rowIndex, xColumnIndex), xOption.kind);
    if (!x) {
      droppedX += 1;
      continue;
    }

    const yValues = yColumnIndexes.map(columnIndex => {
      const raw = table.cellValue(rowIndex, columnIndex);
      if (isMissing(raw)) {
        yMissing += 1;
        return null;
      }
      const y = normalizeNumericValue(raw);
      if (y === null) {
        yInvalid += 1;
      }
      return y;
    });
    points.push({ rowIndex, x: x.value, xText: x.text, y: yValues });
  }

  if (droppedX > 0) {
    warnings.push(`${droppedX} row${droppedX === 1 ? '' : 's'} dropped because x was null, non-finite, or not ${xOption.kind}.`);
  }
  if (yMissing > 0 || yInvalid > 0) {
    warnings.push('Null and non-finite y values are rendered as line gaps where sampled.');
  }

  if (points.length === 0) {
    throw new ChartDataError('No rows have a plottable x value.');
  }
  if (!hasAnyFiniteY(points)) {
    throw new ChartDataError('No selected y column has finite numeric values.');
  }

  const sorted = !isSortedByX(points);
  if (sorted) {
    points.sort((left, right) => {
      if (left.x < right.x) {
        return -1;
      }
      if (left.x > right.x) {
        return 1;
      }
      return left.rowIndex - right.rowIndex;
    });
    warnings.push('x values were sorted for this chart; table order was not changed.');
  }

  const maxSampledPoints = chartTargetPointCount(request.width, request.maxSampledPoints);
  const sampled = downsampleMinMax(points, yColumnNames.length, maxSampledPoints);
  const series = yColumnNames.map((columnName, seriesIndex) => {
    return {
      columnName,
      values: sampled.points.map(point => point.y[seriesIndex]),
    };
  });

  return {
    version: request.version,
    requestId: request.requestId,
    xColumn: request.xColumn,
    xKind: xOption.kind,
    x: sampled.points.map(point => point.x),
    xText: sampled.points.map(point => point.xText),
    series,
    sourceRowCount: table.rowCount,
    eligibleRowCount: points.length,
    sampledPointCount: sampled.points.length,
    algorithm: sampled.algorithm,
    sorted,
    warnings,
  };
}

export function chartTargetPointCount(width: number, maxSampledPoints = CHART_MAX_SAMPLED_POINTS): number {
  const pixelWidth = Math.max(1, Math.floor(Number(width) || 0));
  const target = Math.max(200, pixelWidth * CHART_POINTS_PER_PIXEL);
  return Math.min(positiveInteger(maxSampledPoints, CHART_MAX_SAMPLED_POINTS), target);
}

export function inferColumn(
  table: ColumnarPanelResult,
  columnIndex: number,
  sampleSize = CHART_INFERENCE_SAMPLE_SIZE
): ColumnInference {
  let sampled = 0;
  let missing = 0;
  let numeric = 0;
  let temporal = 0;
  let invalid = 0;
  if (columnIndex < 0 || columnIndex >= table.columns.length || table.rowCount <= 0) {
    return { numeric: false, temporal: false, sampled, missing, invalid };
  }

  const targetSamples = Math.max(1, Math.floor(sampleSize));
  const step = Math.max(1, Math.floor(table.rowCount / targetSamples));
  for (let rowIndex = 0; rowIndex < table.rowCount && sampled < targetSamples; rowIndex += step) {
    const value = table.cellValue(rowIndex, columnIndex);
    if (isMissing(value) || isNonFiniteScalar(value)) {
      missing += 1;
      continue;
    }
    sampled += 1;
    if (normalizeNumericValue(value) !== null) {
      numeric += 1;
      continue;
    }
    if (normalizeTemporalValue(value) !== null) {
      temporal += 1;
      continue;
    }
    invalid += 1;
  }

  return {
    numeric: sampled > 0 && numeric === sampled,
    temporal: sampled > 0 && temporal === sampled,
    sampled,
    missing,
    invalid,
  };
}

function optionLookup(options: ChartColumnOption[]): { [columnName: string]: ChartColumnOption } {
  const lookup: { [columnName: string]: ChartColumnOption } = Object.create(null);
  options.forEach(option => {
    if (!lookup[option.columnName]) {
      lookup[option.columnName] = option;
    }
  });
  return lookup;
}

function uniqueStrings(values: string[]): string[] {
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

function normalizeXValue(value: unknown, kind: ChartColumnKind): NormalizedValue | null {
  return kind === 'temporal' ? normalizeTemporalValue(value) : normalizeNumericValueWithText(value);
}

function normalizeNumericValue(value: unknown): number | null {
  const normalized = normalizeNumericValueWithText(value);
  return normalized ? normalized.value : null;
}

function normalizeNumericValueWithText(value: unknown): NormalizedValue | null {
  if (isMissing(value)) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { value, text: String(value) } : null;
  }
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isFinite(number) ? { value: number, text: String(value) } : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(text)) {
      return null;
    }
    const number = Number(text);
    return Number.isFinite(number) ? { value: number, text } : null;
  }
  return null;
}

function normalizeTemporalValue(value: unknown): NormalizedValue | null {
  if (isMissing(value)) {
    return null;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? { value: time, text: value.toISOString() } : null;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const text = value.trim();
  let match = /^(\d{4})\.(\d{2})$/.exec(text);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month >= 1 && month <= 12) {
      return { value: Date.UTC(year, month - 1, 1), text };
    }
  }

  match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(text);
  if (match) {
    const time = Date.parse(text);
    return Number.isFinite(time) ? { value: time, text } : null;
  }

  match = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,9}))?)?$/.exec(text);
  if (match) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = match[3] ? Number(match[3]) : 0;
    const fraction = match[4] ? Number(`0.${match[4]}`) : 0;
    return { value: ((hours * 60 + minutes) * 60 + seconds + fraction) * 1000, text };
  }

  return null;
}

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function isNonFiniteScalar(value: unknown): boolean {
  if (typeof value === 'number') {
    return !Number.isFinite(value);
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    return text === 'nan' || text === 'inf' || text === '+inf' || text === '-inf' ||
      text === 'infinity' || text === '+infinity' || text === '-infinity';
  }
  return false;
}

function isSortedByX(points: ChartPoint[]): boolean {
  for (let index = 1; index < points.length; index++) {
    if (points[index - 1].x > points[index].x) {
      return false;
    }
  }
  return true;
}

function hasAnyFiniteY(points: ChartPoint[]): boolean {
  for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
    const point = points[pointIndex];
    for (let seriesIndex = 0; seriesIndex < point.y.length; seriesIndex++) {
      if (Number.isFinite(point.y[seriesIndex])) {
        return true;
      }
    }
  }
  return false;
}

function downsampleMinMax(
  points: ChartPoint[],
  seriesCount: number,
  maxPoints: number
): { points: ChartPoint[]; algorithm: string } {
  if (points.length <= maxPoints) {
    return { points, algorithm: 'none' };
  }

  if (maxPoints < 4 || points.length <= 2) {
    return {
      points: [points[0], points[points.length - 1]],
      algorithm: `minmax-bucket/${maxPoints}`,
    };
  }

  const selected: boolean[] = [];
  selected[0] = true;
  selected[points.length - 1] = true;

  const pickSlotsPerBucket = Math.max(1, seriesCount * 2);
  const bucketCount = Math.max(1, Math.floor((maxPoints - 2) / pickSlotsPerBucket));
  const innerStart = 1;
  const innerEnd = points.length - 2;
  const innerCount = Math.max(0, innerEnd - innerStart + 1);
  const bucketSize = innerCount / bucketCount;

  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = Math.min(innerEnd, innerStart + Math.floor(bucket * bucketSize));
    const end = Math.min(innerEnd, innerStart + Math.floor((bucket + 1) * bucketSize) - 1);
    if (start > end) {
      continue;
    }
    let anySelected = false;
    for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex++) {
      let minValue = Infinity;
      let maxValue = -Infinity;
      let minIndex = -1;
      let maxIndex = -1;
      for (let index = start; index <= end; index++) {
        const value = points[index].y[seriesIndex];
        if (!Number.isFinite(value)) {
          continue;
        }
        if ((value as number) < minValue) {
          minValue = value as number;
          minIndex = index;
        }
        if ((value as number) > maxValue) {
          maxValue = value as number;
          maxIndex = index;
        }
      }
      if (minIndex >= 0) {
        selected[minIndex] = true;
        anySelected = true;
      }
      if (maxIndex >= 0) {
        selected[maxIndex] = true;
        anySelected = true;
      }
    }
    if (!anySelected) {
      selected[start] = true;
    }
  }

  const sampled = points.filter((_point, index) => selected[index]);
  return {
    points: sampled.length <= maxPoints ? sampled : evenlyThin(sampled, maxPoints),
    algorithm: `minmax-bucket/${maxPoints}`,
  };
}

function evenlyThin(points: ChartPoint[], maxPoints: number): ChartPoint[] {
  if (points.length <= maxPoints) {
    return points;
  }
  const result: ChartPoint[] = [];
  const last = points.length - 1;
  for (let index = 0; index < maxPoints; index++) {
    result.push(points[Math.round(index * last / (maxPoints - 1))]);
  }
  return result;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
