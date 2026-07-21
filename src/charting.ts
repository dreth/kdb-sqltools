import { ColumnarPanelResult } from './kdb-results';

export type ChartColumnKind = 'numeric' | 'temporal';
export type ChartGroupColumnKind = 'categorical';
export type ChartType = 'line' | 'scatter' | 'step' | 'bar' | 'box' | 'candlestick';

export interface ChartTypeCapabilities {
  usesGenericY: boolean;
  supportsGroupBy: boolean;
  usesOhlc: boolean;
}

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
  yColumns?: string[];
  groupByColumn?: string;
  openColumn?: string;
  highColumn?: string;
  lowColumn?: string;
  closeColumn?: string;
  xMin?: number;
  xMax?: number;
  width: number;
  version: number;
  requestId: number;
  maxSourceRows?: number;
  maxSampledPoints?: number;
  minSampledPoints?: number;
}

export interface LineChartSeries {
  columnName: string;
  sourceColumnName?: string;
  groupValue?: string;
  values: Array<number | null>;
  gapFlags?: boolean[];
}

export interface CandlestickColumns {
  open: string;
  high: string;
  low: string;
  close: string;
}

export interface CandlestickInputPoint {
  rowIndex?: number;
  x: number;
  xText: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
}

export interface CandlestickDataPoint {
  x: number;
  xText: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CandlestickAggregationResult {
  candlesticks: CandlestickDataPoint[];
  exactPointCount: number;
  algorithm: string;
  xDomain?: { min: number; max: number };
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
  xDomain?: { min: number; max: number };
  series: LineChartSeries[];
  boxSeries?: BoxChartSeries[];
  ohlcColumns?: CandlestickColumns;
  candlesticks?: CandlestickDataPoint[];
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
  gapFlags?: boolean[];
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

interface PreparedCandlestickSource {
  xOption: ChartColumnOption;
  ohlcColumns: CandlestickColumns;
  ohlcColumnIndexes: [number, number, number, number];
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

interface CollectedCandlestickPoints {
  points: CandlestickInputPoint[];
  droppedX: number;
  rangeExcluded: number;
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
export const CHART_ZOOM_MIN_SAMPLED_POINTS = 3000;
export const CHART_ZOOM_MAX_SAMPLED_POINTS = 7000;
export const CHART_POINTS_PER_PIXEL = 3;
export const CHART_CANDLES_PER_PIXEL = 1;
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
  if (chartType === 'candlestick') {
    return buildCandlestickChartData(table, request);
  }
  if (chartType === 'box') {
    return buildBoxChartData(table, request);
  }
  return buildXyChartData(table, request, chartType);
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
    case 'candlestick':
      return 'candlestick';
    case 'line':
    default:
      return 'line';
  }
}

export function chartTypeCapabilities(value: unknown): ChartTypeCapabilities {
  const chartType = normalizeChartType(value);
  if (chartType === 'candlestick') {
    return { usesGenericY: false, supportsGroupBy: false, usesOhlc: true };
  }
  if (chartType === 'box') {
    return { usesGenericY: true, supportsGroupBy: false, usesOhlc: false };
  }
  return { usesGenericY: true, supportsGroupBy: true, usesOhlc: false };
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

  const maxSampledPoints = chartRequestTargetPointCount(request, xRange);
  const preparedPoints = chartType === 'bar' || !!source.groupColumnName
    ? consolidateChartPointsByX(grouped.points, grouped.series, chartType, warnings)
    : grouped.points;
  const sampled = chartType === 'bar'
    ? downsampleBarClusters(preparedPoints, maxSampledPoints, warnings)
    : downsampleMinMax(
      preparedPoints,
      grouped.series.length,
      maxSampledPoints,
      chartType === 'line' || chartType === 'step'
    );
  const xDomain = preparedPoints.length > 0
    ? { min: preparedPoints[0].x, max: preparedPoints[preparedPoints.length - 1].x }
    : undefined;
  const series = grouped.series.map((definition, seriesIndex) => {
    const gapFlags = sampled.points.map(point => !!point.gapFlags && point.gapFlags[seriesIndex] === true);
    const result: LineChartSeries = {
      ...definition,
      values: sampled.points.map(point => point.y[seriesIndex]),
    };
    if (source.groupColumnName) {
      result.gapFlags = gapFlags;
    }
    return result;
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
    xDomain,
    series,
    sourceRowCount: table.rowCount,
    eligibleRowCount: points.length,
    sampledPointCount: sampled.points.length,
    algorithm: sampled.algorithm,
    sorted,
    warnings,
  };
}

function buildCandlestickChartData(table: ColumnarPanelResult, request: LineChartRequest): LineChartData {
  if (String(request.groupByColumn || '').trim()) {
    throw new ChartDataError('Group by is not supported for candlestick charts.');
  }
  const source = prepareCandlestickSource(table, request);
  const xRange = normalizedChartXRange(request);
  const warnings = source.warnings.slice();
  const collected = collectCandlestickPoints(table, source, xRange);
  if (collected.droppedX > 0) {
    warnings.push(`${collected.droppedX} row${collected.droppedX === 1 ? '' : 's'} dropped because x was null, non-finite, or not ${source.xOption.kind}.`);
  }
  if (collected.rangeExcluded > 0) {
    warnings.push(`${collected.rangeExcluded} row${collected.rangeExcluded === 1 ? '' : 's'} outside the selected x range were skipped.`);
  }
  if (collected.points.length === 0) {
    throw new ChartDataError(xRange ? 'No rows have a plottable candlestick x value in the selected x range.' : 'No rows have a plottable candlestick x value.');
  }

  const sorted = sortCandlestickPoints(collected.points, warnings);
  const targetPointCount = candlestickTargetPointCount(request.width, request.maxSampledPoints);
  const aggregation = aggregateCandlestickPoints(collected.points, targetPointCount);
  if (aggregation.exactPointCount < collected.points.length) {
    warnings.push(`Candlestick data aggregated ${collected.points.length} eligible rows into ${aggregation.exactPointCount} distinct x candles.`);
  }
  if (aggregation.candlesticks.length < aggregation.exactPointCount) {
    warnings.push(`Candlestick data downsampled ${aggregation.exactPointCount} distinct x candles into ${aggregation.candlesticks.length} financial x buckets.`);
  }

  return {
    version: request.version,
    requestId: request.requestId,
    chartType: 'candlestick',
    xColumn: request.xColumn,
    groupByColumn: undefined,
    xKind: source.xOption.kind,
    x: aggregation.candlesticks.map(candlestick => candlestick.x),
    xText: aggregation.candlesticks.map(candlestick => candlestick.xText),
    xDomain: aggregation.xDomain,
    series: [{
      columnName: 'OHLC',
      sourceColumnName: source.ohlcColumns.close,
      values: aggregation.candlesticks.map(candlestick => candlestick.close),
    }],
    ohlcColumns: source.ohlcColumns,
    candlesticks: aggregation.candlesticks,
    sourceRowCount: table.rowCount,
    eligibleRowCount: collected.points.length,
    sampledPointCount: aggregation.candlesticks.length,
    algorithm: aggregation.algorithm,
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
  const maxGroups = boxChartTargetGroupCount(
    points.length,
    source.yColumnNames.length,
    request.width,
    chartRequestTargetPointCount(request, xRange)
  );
  const bins = buildBoxChartBins(points, source.yColumnNames.length, maxGroups);
  const xDomain = { min: points[0].x, max: points[points.length - 1].x };
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
    xDomain,
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

  const yColumnNames = uniqueStrings(request.yColumns || []);
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

function prepareCandlestickSource(table: ColumnarPanelResult, request: LineChartRequest): PreparedCandlestickSource {
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

  const selections = [
    { role: 'open', label: 'Open', columnName: String(request.openColumn || '') },
    { role: 'high', label: 'High', columnName: String(request.highColumn || '') },
    { role: 'low', label: 'Low', columnName: String(request.lowColumn || '') },
    { role: 'close', label: 'Close', columnName: String(request.closeColumn || '') },
  ];
  selections.forEach(selection => {
    if (!selection.columnName.trim()) {
      throw new ChartDataError(`Select a numeric ${selection.label} column for candlestick charts.`);
    }
  });

  const rolesByColumn: { [columnName: string]: string[] } = Object.create(null);
  selections.forEach(selection => {
    const roles = rolesByColumn[selection.columnName] || [];
    roles.push(selection.label);
    rolesByColumn[selection.columnName] = roles;
  });
  const duplicateColumn = Object.keys(rolesByColumn).filter(columnName => rolesByColumn[columnName].length > 1)[0];
  if (duplicateColumn) {
    throw new ChartDataError(`Candlestick Open, High, Low, and Close must use four distinct numeric columns; ${rolesByColumn[duplicateColumn].join(' and ')} both select ${duplicateColumn}.`);
  }

  const yOptionsByName = optionLookup(options.yColumns);
  const indexes: number[] = [];
  selections.forEach(selection => {
    const option = yOptionsByName[selection.columnName];
    if (!option) {
      throw new ChartDataError(`Candlestick ${selection.label} column ${selection.columnName} is not eligible as a numeric column.`);
    }
    indexes.push(option.columnIndex);
  });

  const warnings = options.warnings.slice();
  if (raisedSourceRowLimit) {
    warnings.push('Chart source exceeds the default row guard. Very large chartMaxSourceRows values can make rendering slow or temporarily block the extension host, especially with multiple y columns.');
  }

  return {
    xOption,
    ohlcColumns: {
      open: selections[0].columnName,
      high: selections[1].columnName,
      low: selections[2].columnName,
      close: selections[3].columnName,
    },
    ohlcColumnIndexes: [indexes[0], indexes[1], indexes[2], indexes[3]],
    warnings,
  };
}

function collectCandlestickPoints(
  table: ColumnarPanelResult,
  source: PreparedCandlestickSource,
  xRange?: ChartXRange
): CollectedCandlestickPoints {
  const points: CandlestickInputPoint[] = [];
  let droppedX = 0;
  let rangeExcluded = 0;
  const roles = [
    { label: 'Open', columnName: source.ohlcColumns.open, columnIndex: source.ohlcColumnIndexes[0] },
    { label: 'High', columnName: source.ohlcColumns.high, columnIndex: source.ohlcColumnIndexes[1] },
    { label: 'Low', columnName: source.ohlcColumns.low, columnIndex: source.ohlcColumnIndexes[2] },
    { label: 'Close', columnName: source.ohlcColumns.close, columnIndex: source.ohlcColumnIndexes[3] },
  ];

  for (let rowIndex = 0; rowIndex < table.rowCount; rowIndex++) {
    const x = normalizeXValue(table.cellValue(rowIndex, source.xOption.columnIndex), source.xOption.kind);
    if (!x) {
      droppedX += 1;
      continue;
    }
    if (xRange && (x.value < xRange.min || x.value > xRange.max)) {
      rangeExcluded += 1;
      continue;
    }

    const values: number[] = [];
    roles.forEach(role => {
      const raw = table.cellValue(rowIndex, role.columnIndex);
      if (isMissing(raw)) {
        throw new ChartDataError(`Candlestick ${role.label} column ${role.columnName} is missing at row ${rowIndex + 1} (x ${x.text}); filter or fill the source value before rendering.`);
      }
      const value = normalizeNumericValue(raw);
      if (value === null) {
        throw new ChartDataError(`Candlestick ${role.label} column ${role.columnName} must contain a finite numeric value at row ${rowIndex + 1} (x ${x.text}).`);
      }
      values.push(value);
    });

    validateCandlestickEnvelope(values[0], values[1], values[2], values[3], `row ${rowIndex + 1} (x ${x.text})`);
    points.push({
      rowIndex,
      x: x.value,
      xText: x.text,
      open: values[0],
      high: values[1],
      low: values[2],
      close: values[3],
    });
  }

  return { points, droppedX, rangeExcluded };
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
  const groups = retainedChartGroups(points, groupColumnName, warnings);
  if (groups.length === 0) {
    throw new ChartDataError(`No grouped series has a finite selected y value for ${groupColumnName}.`);
  }
  const finiteCombinations: { [key: string]: boolean } = Object.create(null);
  points.forEach(point => {
    const group = point.group || '';
    if (groups.indexOf(group) === -1) {
      return;
    }
    point.y.forEach((value, yIndex) => {
      if (Number.isFinite(value)) {
        finiteCombinations[`${group}\u0000${yIndex}`] = true;
      }
    });
  });
  const totalFiniteCombinationCount = groups.reduce((count, group) => {
    return count + yColumnNames.reduce((groupCount, _columnName, yIndex) => {
      return groupCount + (finiteCombinations[`${group}\u0000${yIndex}`] ? 1 : 0);
    }, 0);
  }, 0);
  const mappings: Array<{ group: string; yIndex: number }> = [];
  const series: ChartSeriesDefinition[] = [];
  groups.forEach(group => {
    yColumnNames.forEach((columnName, yIndex) => {
      if (!finiteCombinations[`${group}\u0000${yIndex}`] || series.length >= CHART_MAX_GROUPED_SERIES) {
        return;
      }
      mappings.push({ group, yIndex });
      series.push({
        columnName: `${columnName} [${group}]`,
        sourceColumnName: columnName,
        groupValue: group,
      });
    });
  });
  const emptyCombinationCount = groups.length * yColumnNames.length - totalFiniteCombinationCount;
  if (emptyCombinationCount > 0) {
    warnings.push(`Group by ${groupColumnName} omitted ${emptyCombinationCount} group/Y combination${emptyCombinationCount === 1 ? '' : 's'} with no finite values.`);
  }
  if (totalFiniteCombinationCount > CHART_MAX_GROUPED_SERIES) {
    warnings.push(`Group by ${groupColumnName} has ${totalFiniteCombinationCount} finite generated series; showing first ${CHART_MAX_GROUPED_SERIES}.`);
  }
  const mappedGroups: { [group: string]: boolean } = Object.create(null);
  mappings.forEach(mapping => {
    mappedGroups[mapping.group] = true;
  });
  const expandedPoints: ChartPoint[] = [];
  points.forEach(point => {
    const group = point.group || '';
    if (!mappedGroups[group]) {
      return;
    }
    const y = series.map(() => null as number | null);
    const gapFlags = series.map(() => false);
    mappings.forEach((mapping, seriesIndex) => {
      if (mapping.group !== group) {
        return;
      }
      y[seriesIndex] = point.y[mapping.yIndex];
      gapFlags[seriesIndex] = point.y[mapping.yIndex] === null;
    });
    expandedPoints.push({ ...point, y, gapFlags });
  });
  return { points: expandedPoints, series };
}

function consolidateChartPointsByX(
  points: ChartPoint[],
  series: ChartSeriesDefinition[],
  chartType: ChartType,
  warnings: string[]
): ChartPoint[] {
  const clusters: ChartPoint[] = [];
  let start = 0;
  while (start < points.length) {
    let end = start + 1;
    while (end < points.length && points[end].x === points[start].x) {
      end += 1;
    }

    const clusterPoints = points.slice(start, end);
    const values = series.map(() => null as number | null);
    const hasGapFlags = clusterPoints.some(point => Array.isArray(point.gapFlags));
    const gapFlags = series.map(() => false);
    clusterPoints.forEach(point => {
      series.forEach((definition, seriesIndex) => {
        const value = point.y[seriesIndex];
        if (!Number.isFinite(value)) {
          if (point.gapFlags && point.gapFlags[seriesIndex] === true) {
            gapFlags[seriesIndex] = true;
          }
          return;
        }
        if (Number.isFinite(values[seriesIndex])) {
          const label = chartType === 'bar' ? 'Bar chart' : `${chartTypeLabel(chartType)} chart grouping`;
          throw new ChartDataError(`${label} has multiple finite values for ${definition.columnName} at x ${points[start].xText}; use a unique x value per group or aggregate the source in q.`);
        }
        values[seriesIndex] = value;
        gapFlags[seriesIndex] = false;
      });
    });
    values.forEach((value, seriesIndex) => {
      if (Number.isFinite(value)) {
        gapFlags[seriesIndex] = false;
      }
    });

    const cluster: ChartPoint = {
      ...points[start],
      y: values,
    };
    if (hasGapFlags) {
      cluster.gapFlags = gapFlags;
    } else {
      delete cluster.gapFlags;
    }
    clusters.push(cluster);
    start = end;
  }

  if (clusters.length < points.length) {
    warnings.push(chartType === 'bar'
      ? `Bar chart aligned ${points.length} eligible rows into ${clusters.length} distinct x clusters without stacking overlapping bars.`
      : `${chartTypeLabel(chartType)} chart aligned ${points.length} grouped rows into ${clusters.length} distinct x positions.`);
  }
  return clusters;
}

function downsampleBarClusters(
  points: ChartPoint[],
  maxPoints: number,
  warnings: string[]
): { points: ChartPoint[]; algorithm: string } {
  const limit = positiveInteger(maxPoints, CHART_MAX_SAMPLED_POINTS);
  if (points.length <= limit) {
    return { points, algorithm: `bar-cluster/${points.length}` };
  }
  if (limit === 1) {
    warnings.push(`Bar chart sampled ${points.length} distinct x clusters to 1; the first cluster keeps all selected series.`);
    return { points: [points[0]], algorithm: 'bar-cluster-even/1' };
  }
  const sampled = evenlyThin(points, limit);
  warnings.push(`Bar chart sampled ${points.length} distinct x clusters to ${sampled.length}; every retained cluster keeps all selected series.`);
  return { points: sampled, algorithm: `bar-cluster-even/${limit}` };
}

function retainedChartGroups(points: ChartPoint[], groupColumnName: string, warnings: string[]): string[] {
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
  const finiteGroups = groups.filter(group => hasFiniteY[group]);
  const omittedEmptyCount = groups.length - finiteGroups.length;
  if (omittedEmptyCount > 0) {
    warnings.push(`Group by ${groupColumnName} omitted ${omittedEmptyCount} categor${omittedEmptyCount === 1 ? 'y' : 'ies'} with no finite selected y values.`);
  }
  if (finiteGroups.length > CHART_MAX_GROUPS) {
    warnings.push(`Group by ${groupColumnName} has ${finiteGroups.length} categories with finite values; showing first ${CHART_MAX_GROUPS}.`);
  }
  return finiteGroups.slice(0, CHART_MAX_GROUPS);
}

function chartTypeLabel(chartType: ChartType): string {
  return chartType.slice(0, 1).toUpperCase() + chartType.slice(1);
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

function sortCandlestickPoints(points: CandlestickInputPoint[], warnings: string[]): boolean {
  let requiresSort = false;
  for (let index = 1; index < points.length; index++) {
    if (points[index - 1].x > points[index].x) {
      requiresSort = true;
      break;
    }
  }
  if (requiresSort) {
    points.sort((left, right) => {
      if (left.x < right.x) {
        return -1;
      }
      if (left.x > right.x) {
        return 1;
      }
      return Number(left.rowIndex || 0) - Number(right.rowIndex || 0);
    });
    warnings.push('x values were sorted for this candlestick chart; table order was not changed.');
  }
  return requiresSort;
}

export function chartTargetPointCount(
  width: number,
  maxSampledPoints = CHART_MAX_SAMPLED_POINTS,
  minSampledPoints = 0
): number {
  const pixelWidth = Math.max(1, Math.floor(Number(width) || 0));
  const maxPoints = positiveInteger(maxSampledPoints, CHART_MAX_SAMPLED_POINTS);
  const minPoints = Math.min(maxPoints, nonNegativeInteger(minSampledPoints, 0));
  const target = Math.max(200, pixelWidth * CHART_POINTS_PER_PIXEL, minPoints);
  return Math.min(maxPoints, target);
}

export function candlestickTargetPointCount(
  width: number,
  maxSampledPoints = CHART_MAX_SAMPLED_POINTS
): number {
  const pixelWidth = Math.max(1, Math.floor(Number(width) || 0));
  const maxPoints = positiveInteger(maxSampledPoints, CHART_MAX_SAMPLED_POINTS);
  return Math.min(maxPoints, pixelWidth * CHART_CANDLES_PER_PIXEL);
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

export function aggregateCandlestickPoints(
  points: CandlestickInputPoint[],
  maxPoints: number
): CandlestickAggregationResult {
  if (points.length === 0) {
    return { candlesticks: [], exactPointCount: 0, algorithm: 'ohlc-exact/0' };
  }

  if (points.some(point => !Number.isFinite(point.x))) {
    throw new ChartDataError('Candlestick aggregation requires finite numeric x values.');
  }

  const sorted = points.map((point, index) => ({ point, index })).sort((left, right) => {
    if (left.point.x < right.point.x) {
      return -1;
    }
    if (left.point.x > right.point.x) {
      return 1;
    }
    const leftRow = Number.isFinite(left.point.rowIndex) ? Number(left.point.rowIndex) : left.index;
    const rightRow = Number.isFinite(right.point.rowIndex) ? Number(right.point.rowIndex) : right.index;
    return leftRow === rightRow ? left.index - right.index : leftRow - rightRow;
  }).map(item => item.point);

  sorted.forEach(point => validatePartialCandlestickEnvelope(point, `x ${point.xText || point.x}`));

  const exact: CandlestickDataPoint[] = [];
  let start = 0;
  while (start < sorted.length) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].x === sorted[start].x) {
      end += 1;
    }
    exact.push(aggregateCandlestickBucket(sorted.slice(start, end)));
    start = end;
  }
  const xDomain = { min: exact[0].x, max: exact[exact.length - 1].x };

  const limit = positiveInteger(maxPoints, CHART_MAX_SAMPLED_POINTS);
  if (exact.length <= limit) {
    return {
      candlesticks: exact,
      exactPointCount: exact.length,
      algorithm: `ohlc-exact/${exact.length}`,
      xDomain,
    };
  }

  const bucketCount = Math.max(1, Math.min(limit, exact.length));
  const buckets: CandlestickDataPoint[][] = Array.from({ length: bucketCount }, () => []);
  const domainScale = Math.max(1, Math.abs(xDomain.min), Math.abs(xDomain.max));
  const scaledMin = xDomain.min / domainScale;
  const scaledMax = xDomain.max / domainScale;
  const scaledSpan = scaledMax - scaledMin;
  exact.forEach((point, pointIndex) => {
    const position = scaledSpan > 0
      ? ((point.x / domainScale) - scaledMin) / scaledSpan
      : pointIndex / Math.max(1, exact.length - 1);
    const bucketIndex = pointIndex === exact.length - 1
      ? bucketCount - 1
      : Math.max(0, Math.min(bucketCount - 1, Math.floor(position * bucketCount)));
    buckets[bucketIndex].push(point);
  });
  const candlesticks: CandlestickDataPoint[] = [];
  buckets.forEach(bucket => {
    if (bucket.length === 0) {
      return;
    }
    candlesticks.push(aggregateCandlestickBucket(bucket.map((point, pointIndex) => ({
      ...point,
      rowIndex: pointIndex,
    }))));
  });
  return {
    candlesticks,
    exactPointCount: exact.length,
    algorithm: `ohlc-bucket/${candlesticks.length}`,
    xDomain,
  };
}

function aggregateCandlestickBucket(points: CandlestickInputPoint[]): CandlestickDataPoint {
  if (points.length === 0) {
    throw new ChartDataError('Candlestick aggregation cannot create an empty x bucket.');
  }
  let open: number | null = null;
  let high: number | null = null;
  let low: number | null = null;
  let close: number | null = null;
  points.forEach(point => {
    if (open === null && Number.isFinite(point.open)) {
      open = point.open;
    }
    if (Number.isFinite(point.high)) {
      high = high === null ? point.high : Math.max(high, point.high as number);
    }
    if (Number.isFinite(point.low)) {
      low = low === null ? point.low : Math.min(low, point.low as number);
    }
    if (Number.isFinite(point.close)) {
      close = point.close;
    }
  });

  const first = points[0];
  const last = points[points.length - 1];
  const xDescription = first.x === last.x
    ? (first.xText || String(first.x))
    : `${first.xText || first.x}..${last.xText || last.x}`;
  if (open === null) {
    throw new ChartDataError(`Candlestick x bucket ${xDescription} has no finite Open value.`);
  }
  if (high === null) {
    throw new ChartDataError(`Candlestick x bucket ${xDescription} has no finite High value.`);
  }
  if (low === null) {
    throw new ChartDataError(`Candlestick x bucket ${xDescription} has no finite Low value.`);
  }
  if (close === null) {
    throw new ChartDataError(`Candlestick x bucket ${xDescription} has no finite Close value.`);
  }
  validateCandlestickEnvelope(open, high, low, close, `x bucket ${xDescription}`);
  return {
    x: first.x === last.x ? first.x : first.x / 2 + last.x / 2,
    xText: xDescription,
    open,
    high,
    low,
    close,
  };
}

function validatePartialCandlestickEnvelope(point: CandlestickInputPoint, context: string): void {
  const open = Number.isFinite(point.open) ? point.open as number : null;
  const high = Number.isFinite(point.high) ? point.high as number : null;
  const low = Number.isFinite(point.low) ? point.low as number : null;
  const close = Number.isFinite(point.close) ? point.close as number : null;
  if (high !== null && low !== null && high < low) {
    throw new ChartDataError(`Invalid candlestick ${context}: High ${high} must be greater than or equal to Low ${low}.`);
  }
  if (high !== null && ((open !== null && high < open) || (close !== null && high < close))) {
    throw new ChartDataError(`Invalid candlestick ${context}: High ${high} must be greater than or equal to Open and Close.`);
  }
  if (low !== null && ((open !== null && low > open) || (close !== null && low > close))) {
    throw new ChartDataError(`Invalid candlestick ${context}: Low ${low} must be less than or equal to Open and Close.`);
  }
}

function validateCandlestickEnvelope(open: number, high: number, low: number, close: number, context: string): void {
  validatePartialCandlestickEnvelope({ x: 0, xText: context, open, high, low, close }, context);
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

  const xRuns: Array<{ start: number; end: number }> = [];
  let runStart = 0;
  while (runStart < points.length) {
    let runEnd = runStart + 1;
    while (runEnd < points.length && points[runEnd].x === points[runStart].x) {
      runEnd += 1;
    }
    xRuns.push({ start: runStart, end: runEnd });
    runStart = runEnd;
  }

  const groupCount = Math.max(1, Math.min(maxGroups, xRuns.length));
  const bins: BoxChartBin[] = [];
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const firstRunIndex = Math.floor(groupIndex * xRuns.length / groupCount);
    const lastRunIndex = Math.max(firstRunIndex, Math.floor((groupIndex + 1) * xRuns.length / groupCount) - 1);
    const group = points.slice(xRuns[firstRunIndex].start, xRuns[lastRunIndex].end);
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

function chartRequestTargetPointCount(request: LineChartRequest, xRange?: ChartXRange): number {
  if (xRange) {
    return positiveInteger(request.maxSampledPoints, CHART_ZOOM_MAX_SAMPLED_POINTS);
  }
  return chartTargetPointCount(request.width, request.maxSampledPoints, request.minSampledPoints);
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
  maxPoints: number,
  preserveSourceGaps: boolean
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

  const gapSeries = new Array(seriesCount).fill(false);
  if (preserveSourceGaps) {
    points.forEach(point => {
      for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex++) {
        const sourceGap = Array.isArray(point.gapFlags)
          ? point.gapFlags[seriesIndex] === true
          : point.y[seriesIndex] === null;
        gapSeries[seriesIndex] = gapSeries[seriesIndex] || sourceGap;
      }
    });
  }
  const gapSeriesCount = gapSeries.filter(Boolean).length;
  const pickSlotsPerBucket = Math.max(1, seriesCount * 2 + gapSeriesCount);
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
      let gapIndex = -1;
      for (let index = start; index <= end; index++) {
        const value = points[index].y[seriesIndex];
        if (!Number.isFinite(value)) {
          const isSourceGap = gapSeries[seriesIndex] && (Array.isArray(points[index].gapFlags)
            ? points[index].gapFlags![seriesIndex] === true
            : value === null);
          if (isSourceGap && gapIndex === -1) {
            gapIndex = index;
          }
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
      if (gapIndex >= 0) {
        selected[gapIndex] = true;
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

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
