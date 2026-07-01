import { ColumnarPanelResult } from './kdb-results';

export type ChartColumnKind = 'numeric' | 'temporal';
export type ChartGroupColumnKind = 'categorical';
export type ChartType = 'line' | 'scatter' | 'step' | 'bar' | 'box';

export interface ChartColumnOption {
  columnName: string;
  columnIndex: number;
  kind: ChartColumnKind;
}

export interface ChartGroupColumnOption {
  columnName: string;
  columnIndex: number;
  kind: ChartGroupColumnKind;
}

export interface ChartColumnOptions {
  xColumns: ChartColumnOption[];
  yColumns: ChartColumnOption[];
  groupColumns: ChartGroupColumnOption[];
  warnings: string[];
}

export interface LineChartRequest {
  chartType?: ChartType;
  xColumn: string;
  yColumns: string[];
  groupByColumn?: string;
  xMin?: number;
  xMax?: number;
  width: number;
  version: number;
  requestId: number;
  maxSourceRows?: number;
  maxSampledPoints?: number;
}

export interface LineChartSeries {
  columnName: string;
  sourceColumnName?: string;
  groupValue?: string;
  values: Array<number | null>;
}

export interface BoxChartStats {
  count: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

export interface BoxChartSeries {
  columnName: string;
  stats: Array<BoxChartStats | null>;
}

export interface LineChartData {
  version: number;
  requestId: number;
  chartType: ChartType;
  xColumn: string;
  groupByColumn?: string;
  xKind: ChartColumnKind;
  x: number[];
  xText: string[];
  series: LineChartSeries[];
  boxSeries?: BoxChartSeries[];
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
  group?: string;
  y: Array<number | null>;
}

interface NormalizedValue {
  value: number;
  text: string;
}

interface ColumnInference {
  numeric: boolean;
  temporal: boolean;
  categorical: boolean;
  sampled: number;
  missing: number;
  invalid: number;
}

interface PreparedChartSource {
  xOption: ChartColumnOption;
  yColumnNames: string[];
  yColumnIndexes: number[];
  groupColumnName?: string;
  groupColumnIndex?: number;
  warnings: string[];
}

interface CollectedChartPoints {
  points: ChartPoint[];
  droppedX: number;
  droppedGroup: number;
  rangeExcluded: number;
  yMissing: number;
  yInvalid: number;
}

interface BoxChartBin {
  x: number;
  xText: string;
  stats: Array<BoxChartStats | null>;
}

interface ChartXRange {
  min: number;
  max: number;
}

interface ChartSeriesDefinition {
  columnName: string;
  sourceColumnName?: string;
  groupValue?: string;
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
export const CHART_MAX_BOX_GROUPS = 120;
export const CHART_MAX_GROUPS = 12;
export const CHART_MAX_GROUPED_SERIES = 36;

export function chartColumnOptions(table: ColumnarPanelResult, sampleSize = CHART_INFERENCE_SAMPLE_SIZE): ChartColumnOptions {
  const xColumns: ChartColumnOption[] = [];
  const yColumns: ChartColumnOption[] = [];
  const groupColumns: ChartGroupColumnOption[] = [];
  const warnings: string[] = [];

  table.columns.forEach((columnName, columnIndex) => {
    const inference = inferColumn(table, columnIndex, sampleSize);
    if (inference.numeric) {
      xColumns.push({ columnName, columnIndex, kind: 'numeric' });
      yColumns.push({ columnName, columnIndex, kind: 'numeric' });
    } else if (inference.temporal) {
      xColumns.push({ columnName, columnIndex, kind: 'temporal' });
    }
    if (inference.categorical) {
      groupColumns.push({ columnName, columnIndex, kind: 'categorical' });
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

  return { xColumns, yColumns, groupColumns, warnings };
}

export function buildLineChartData(table: ColumnarPanelResult, request: LineChartRequest): LineChartData {
  return buildChartData(table, { ...request, chartType: 'line' });
}

export function buildChartData(table: ColumnarPanelResult, request: LineChartRequest): LineChartData {
  const chartType = normalizeChartType(request.chartType);
  return chartType === 'box'
    ? buildBoxChartData(table, request)
    : buildXyChartData(table, request, chartType);
}

export function normalizeChartType(value: unknown): ChartType {
  switch (String(value || '').toLowerCase()) {
    case 'scatter':
      return 'scatter';
    case 'step':
      return 'step';
    case 'bar':
      return 'bar';
    case 'box':
      return 'box';
    case 'line':
    default:
      return 'line';
  }
}

function buildXyChartData(table: ColumnarPanelResult, request: LineChartRequest, chartType: ChartType): LineChartData {
  const source = prepareChartSource(table, request);
  const xRange = normalizedChartXRange(request);
  const warnings = source.warnings.slice();
  const collected = collectChartPoints(table, source.xOption, source.yColumnIndexes, source.groupColumnIndex, xRange);
  appendCollectedWarnings(warnings, collected, source.xOption.kind, chartType === 'line' || chartType === 'step'
    ? 'Null and non-finite y values are rendered as gaps where sampled.'
    : 'Null and non-finite y values are skipped where sampled.', source.groupColumnName);

  const points = collected.points;
  if (points.length === 0) {
    throw new ChartDataError(xRange ? 'No rows have a plottable x value in the selected x range.' : 'No rows have a plottable x value.');
  }
  const sorted = sortChartPoints(points, warnings);
  const grouped = source.groupColumnName
    ? groupedChartPoints(points, source.yColumnNames, source.groupColumnName, warnings)
    : ungroupedChartPoints(points, source.yColumnNames);
  if (!hasAnyFiniteY(grouped.points)) {
    throw new ChartDataError('No selected y column has finite numeric values.');
  }

  const maxSampledPoints = chartTargetPointCount(request.width, request.maxSampledPoints);
  const sampled = downsampleMinMax(grouped.points, grouped.series.length, maxSampledPoints);
  const series = grouped.series.map((definition, seriesIndex) => {
    return {
      ...definition,
      values: sampled.points.map(point => point.y[seriesIndex]),
    };
  });

  return {
    version: request.version,
    requestId: request.requestId,
    chartType,
    xColumn: request.xColumn,
    groupByColumn: source.groupColumnName,
    xKind: source.xOption.kind,
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

function buildBoxChartData(table: ColumnarPanelResult, request: LineChartRequest): LineChartData {
  if (String(request.groupByColumn || '')) {
    throw new ChartDataError('Group by is not supported for box charts.');
  }
  const source = prepareChartSource(table, request);
  const xRange = normalizedChartXRange(request);
  const warnings = source.warnings.slice();
  const collected = collectChartPoints(table, source.xOption, source.yColumnIndexes, undefined, xRange);
  appendCollectedWarnings(warnings, collected, source.xOption.kind, 'Null and non-finite y values are skipped for box statistics.');

  const points = collected.points;
  if (points.length === 0) {
    throw new ChartDataError(xRange ? 'No rows have a plottable x value in the selected x range.' : 'No rows have a plottable x value.');
  }
  if (!hasAnyFiniteY(points)) {
    throw new ChartDataError('No selected y column has finite numeric values.');
  }

  const sorted = sortChartPoints(points, warnings);
  const maxGroups = boxChartTargetGroupCount(points.length, source.yColumnNames.length, request.width, request.maxSampledPoints);
  const bins = buildBoxChartBins(points, source.yColumnNames.length, maxGroups);
  const boxSeries = source.yColumnNames.map((columnName, seriesIndex) => {
    return {
      columnName,
      stats: bins.map(bin => bin.stats[seriesIndex]),
    };
  });
  if (!boxSeries.some(series => series.stats.some(stats => stats !== null))) {
    throw new ChartDataError('No selected y column has finite numeric values for box statistics.');
  }

  if (bins.length < distinctXCount(points)) {
    warnings.push(`Box plot grouped ${points.length} eligible rows into ${bins.length} x buckets.`);
  }

  return {
    version: request.version,
    requestId: request.requestId,
    chartType: 'box',
    xColumn: request.xColumn,
    groupByColumn: undefined,
    xKind: source.xOption.kind,
    x: bins.map(bin => bin.x),
    xText: bins.map(bin => bin.xText),
    series: source.yColumnNames.map((columnName, seriesIndex) => {
      return {
        columnName,
        values: bins.map(bin => {
          const stats = bin.stats[seriesIndex];
          return stats ? stats.median : null;
        }),
      };
    }),
    boxSeries,
    sourceRowCount: table.rowCount,
    eligibleRowCount: points.length,
    sampledPointCount: bins.length,
    algorithm: bins.length < distinctXCount(points) ? `box-bucket/${bins.length}` : `box-exact/${bins.length}`,
    sorted,
    warnings,
  };
}

function prepareChartSource(table: ColumnarPanelResult, request: LineChartRequest): PreparedChartSource {
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

  const groupByColumn = String(request.groupByColumn || '');
  const groupOptionsByName = groupOptionLookup(options.groupColumns);
  const groupOption = groupByColumn ? groupOptionsByName[groupByColumn] : undefined;
  if (groupByColumn && !groupOption) {
    throw new ChartDataError(`${groupByColumn} is not eligible as a categorical group-by column.`);
  }

  return {
    xOption,
    yColumnNames,
    yColumnIndexes,
    groupColumnName: groupOption ? groupOption.columnName : undefined,
    groupColumnIndex: groupOption ? groupOption.columnIndex : undefined,
    warnings,
  };
}

function collectChartPoints(
  table: ColumnarPanelResult,
  xOption: ChartColumnOption,
  yColumnIndexes: number[],
  groupColumnIndex?: number,
  xRange?: ChartXRange
): CollectedChartPoints {
  const points: ChartPoint[] = [];
  let droppedX = 0;
  let droppedGroup = 0;
  let rangeExcluded = 0;
  let yMissing = 0;
  let yInvalid = 0;
  for (let rowIndex = 0; rowIndex < table.rowCount; rowIndex++) {
    const x = normalizeXValue(table.cellValue(rowIndex, xOption.columnIndex), xOption.kind);
    if (!x) {
      droppedX += 1;
      continue;
    }
    if (xRange && (x.value < xRange.min || x.value > xRange.max)) {
      rangeExcluded += 1;
      continue;
    }

    let group: string | undefined;
    if (groupColumnIndex !== undefined) {
      const groupValue = normalizeCategoricalValue(table.cellValue(rowIndex, groupColumnIndex));
      if (groupValue === null) {
        droppedGroup += 1;
        continue;
      }
      group = groupValue;
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
    points.push({ rowIndex, x: x.value, xText: x.text, group, y: yValues });
  }

  return { points, droppedX, droppedGroup, rangeExcluded, yMissing, yInvalid };
}

function appendCollectedWarnings(
  warnings: string[],
  collected: CollectedChartPoints,
  xKind: ChartColumnKind,
  yWarning: string,
  groupColumnName?: string
): void {
  if (collected.droppedX > 0) {
    warnings.push(`${collected.droppedX} row${collected.droppedX === 1 ? '' : 's'} dropped because x was null, non-finite, or not ${xKind}.`);
  }
  if (collected.rangeExcluded > 0) {
    warnings.push(`${collected.rangeExcluded} row${collected.rangeExcluded === 1 ? '' : 's'} outside the selected x range were skipped.`);
  }
  if (groupColumnName && collected.droppedGroup > 0) {
    warnings.push(`${collected.droppedGroup} row${collected.droppedGroup === 1 ? '' : 's'} dropped because ${groupColumnName} was empty or not scalar.`);
  }
  if (collected.yMissing > 0 || collected.yInvalid > 0) {
    warnings.push(yWarning);
  }
}

function ungroupedChartPoints(points: ChartPoint[], yColumnNames: string[]): { points: ChartPoint[]; series: ChartSeriesDefinition[] } {
  return {
    points,
    series: yColumnNames.map(columnName => ({ columnName, sourceColumnName: columnName })),
  };
}

function groupedChartPoints(
  points: ChartPoint[],
  yColumnNames: string[],
  groupColumnName: string,
  warnings: string[]
): { points: ChartPoint[]; series: ChartSeriesDefinition[] } {
  const groups = retainedChartGroups(points, yColumnNames.length, groupColumnName, warnings);
  if (groups.length === 0) {
    throw new ChartDataError(`No rows have a usable group value for ${groupColumnName}.`);
  }
  const groupIndexes: { [group: string]: number } = Object.create(null);
  groups.forEach((group, index) => {
    groupIndexes[group] = index;
  });
  const series: ChartSeriesDefinition[] = [];
  groups.forEach(group => {
    yColumnNames.forEach(columnName => {
      series.push({
        columnName: `${columnName} [${group}]`,
        sourceColumnName: columnName,
        groupValue: group,
      });
    });
  });
  const expandedPoints: ChartPoint[] = [];
  points.forEach(point => {
    const group = point.group || '';
    const groupIndex = groupIndexes[group];
    if (groupIndex === undefined) {
      return;
    }
    const y = series.map(() => null as number | null);
    yColumnNames.forEach((_columnName, yIndex) => {
      y[groupIndex * yColumnNames.length + yIndex] = point.y[yIndex];
    });
    expandedPoints.push({ ...point, y });
  });
  return { points: expandedPoints, series };
}

function retainedChartGroups(points: ChartPoint[], yColumnCount: number, groupColumnName: string, warnings: string[]): string[] {
  const groups: string[] = [];
  const seen: { [group: string]: boolean } = Object.create(null);
  const hasFiniteY: { [group: string]: boolean } = Object.create(null);
  points.forEach(point => {
    const group = point.group || '';
    if (group && !seen[group]) {
      seen[group] = true;
      groups.push(group);
    }
    if (group && point.y.some(value => Number.isFinite(value))) {
      hasFiniteY[group] = true;
    }
  });
  const maxGroups = Math.max(1, Math.min(CHART_MAX_GROUPS, Math.floor(CHART_MAX_GROUPED_SERIES / Math.max(1, yColumnCount))));
  if (groups.length > maxGroups) {
    warnings.push(`Group by ${groupColumnName} has ${groups.length} categories; showing first ${maxGroups}.`);
  }
  return groups
    .filter(group => hasFiniteY[group])
    .concat(groups.filter(group => !hasFiniteY[group]))
    .slice(0, maxGroups);
}

function sortChartPoints(points: ChartPoint[], warnings: string[]): boolean {
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
  return sorted;
}

export function chartTargetPointCount(width: number, maxSampledPoints = CHART_MAX_SAMPLED_POINTS): number {
  const pixelWidth = Math.max(1, Math.floor(Number(width) || 0));
  const target = Math.max(200, pixelWidth * CHART_POINTS_PER_PIXEL);
  return Math.min(positiveInteger(maxSampledPoints, CHART_MAX_SAMPLED_POINTS), target);
}

export function boxChartTargetGroupCount(
  eligibleRows: number,
  seriesCount: number,
  width: number,
  maxSampledPoints = CHART_MAX_SAMPLED_POINTS
): number {
  const target = chartTargetPointCount(width, maxSampledPoints);
  const maxBySeries = Math.max(8, Math.floor(target / Math.max(1, seriesCount * 8)));
  return Math.max(1, Math.min(Math.max(1, Math.floor(eligibleRows)), CHART_MAX_BOX_GROUPS, maxBySeries));
}

export function boxStats(values: number[]): BoxChartStats | null {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) {
    return null;
  }
  return {
    count: finite.length,
    min: finite[0],
    q1: quantile(finite, 0.25),
    median: quantile(finite, 0.5),
    q3: quantile(finite, 0.75),
    max: finite[finite.length - 1],
  };
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
  let categorical = 0;
  let invalid = 0;
  if (columnIndex < 0 || columnIndex >= table.columns.length || table.rowCount <= 0) {
    return { numeric: false, temporal: false, categorical: false, sampled, missing, invalid };
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
    if (normalizeCategoricalValue(value) !== null) {
      categorical += 1;
      continue;
    }
    invalid += 1;
  }

  return {
    numeric: sampled > 0 && numeric === sampled,
    temporal: sampled > 0 && temporal === sampled,
    categorical: sampled > 0 && categorical === sampled,
    sampled,
    missing,
    invalid,
  };
}

function buildBoxChartBins(points: ChartPoint[], seriesCount: number, maxGroups: number): BoxChartBin[] {
  if (points.length === 0) {
    return [];
  }

  const uniqueCount = distinctXCount(points);
  if (uniqueCount <= maxGroups) {
    const bins: BoxChartBin[] = [];
    let start = 0;
    while (start < points.length) {
      let end = start + 1;
      while (end < points.length && points[end].x === points[start].x) {
        end += 1;
      }
      const group = points.slice(start, end);
      bins.push({
        x: points[start].x,
        xText: points[start].xText,
        stats: boxStatsForPoints(group, seriesCount),
      });
      start = end;
    }
    return bins;
  }

  const groupCount = Math.max(1, Math.min(maxGroups, points.length));
  const bins: BoxChartBin[] = [];
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const start = Math.floor(groupIndex * points.length / groupCount);
    const end = Math.floor((groupIndex + 1) * points.length / groupCount);
    const group = points.slice(start, Math.max(start + 1, end));
    const first = group[0];
    const last = group[group.length - 1];
    bins.push({
      x: (first.x + last.x) / 2,
      xText: first.x === last.x ? first.xText : `${first.xText}..${last.xText}`,
      stats: boxStatsForPoints(group, seriesCount),
    });
  }
  return bins;
}

function boxStatsForPoints(points: ChartPoint[], seriesCount: number): Array<BoxChartStats | null> {
  const stats: Array<BoxChartStats | null> = [];
  for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex++) {
    const values: number[] = [];
    points.forEach(point => {
      const value = point.y[seriesIndex];
      if (Number.isFinite(value)) {
        values.push(value as number);
      }
    });
    stats.push(boxStats(values));
  }
  return stats;
}

function distinctXCount(points: ChartPoint[]): number {
  if (points.length === 0) {
    return 0;
  }
  let count = 1;
  for (let index = 1; index < points.length; index++) {
    if (points[index].x !== points[index - 1].x) {
      count += 1;
    }
  }
  return count;
}

function quantile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }
  const position = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sortedValues[lower];
  }
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
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

function groupOptionLookup(options: ChartGroupColumnOption[]): { [columnName: string]: ChartGroupColumnOption } {
  const lookup: { [columnName: string]: ChartGroupColumnOption } = Object.create(null);
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

function normalizeCategoricalValue(value: unknown): string | null {
  if (isMissing(value) || isNonFiniteScalar(value)) {
    return null;
  }
  let text = '';
  if (typeof value === 'string') {
    text = value.trim();
  } else if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') {
    text = String(value);
  } else if (value instanceof Date) {
    text = value.toISOString();
  }
  if (!text) {
    return null;
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function normalizedChartXRange(request: LineChartRequest): ChartXRange | undefined {
  const hasMin = request.xMin !== undefined && request.xMin !== null;
  const hasMax = request.xMax !== undefined && request.xMax !== null;
  if (!hasMin && !hasMax) {
    return undefined;
  }
  const min = Number(request.xMin);
  const max = Number(request.xMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    throw new ChartDataError('Refine zoom needs a valid x range.');
  }
  return { min, max };
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
