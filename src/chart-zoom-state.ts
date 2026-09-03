export interface ChartZoomRange {
  min: number;
  max: number;
}

export type ChartZoomAutoRefineQueueAction =
  | { type: 'schedule'; range: ChartZoomRange }
  | { type: 'duplicate' }
  | { type: 'flush'; ranges: ChartZoomRange[] };

export interface ChartZoomLifecycleState<T> {
  activeRequestId: number;
  pendingRequestId: number | null;
  requestedRange: ChartZoomRange | null;
  fullRange: ChartZoomRange | null;
  fullData: T | null;
}

export type ChartZoomLifecycleAction<T> =
  | { type: 'clear'; requestId: number }
  | { type: 'request'; requestId: number; range: ChartZoomRange | null }
  | { type: 'response'; requestId: number; data: T }
  | { type: 'failed'; requestId: number }
  | { type: 'rendered'; requestId: number; naturalRange: ChartZoomRange | null }
  | { type: 'reset' };

/** Yield once, then skip a chart build whose owning request became stale. */
export async function runCurrentChartBuild<T>(
  yieldControl: () => Promise<void>,
  isCurrent: () => boolean,
  build: () => T | Promise<T>
): Promise<T | undefined> {
  await yieldControl();
  if (!isCurrent()) {
    return undefined;
  }
  return build();
}

/**
 * Tracks the full sampled response and exact refinement viewport independently.
 * The function is self-contained so the same reducer can run in the webview and
 * in the Node behavioral harness.
 */
export function reduceChartZoomLifecycle<T>(
  state: ChartZoomLifecycleState<T> | null | undefined,
  action: ChartZoomLifecycleAction<T>
): ChartZoomLifecycleState<T> {
  const current = state || {
    activeRequestId: -1,
    pendingRequestId: null,
    requestedRange: null,
    fullRange: null,
    fullData: null,
  };

  if (action.type === 'clear') {
    return {
      activeRequestId: action.requestId,
      pendingRequestId: null,
      requestedRange: null,
      fullRange: null,
      fullData: null,
    };
  }

  if (action.type === 'request') {
    const range = action.range &&
      Number.isFinite(action.range.min) &&
      Number.isFinite(action.range.max) &&
      action.range.max > action.range.min
      ? { min: action.range.min, max: action.range.max }
      : null;
    return range
      ? {
        activeRequestId: action.requestId,
        pendingRequestId: action.requestId,
        requestedRange: range,
        fullRange: current.fullRange,
        fullData: current.fullData,
      }
      : {
        activeRequestId: action.requestId,
        pendingRequestId: action.requestId,
        requestedRange: null,
        fullRange: null,
        fullData: null,
      };
  }

  if (action.type === 'response') {
    if (
      action.requestId !== current.activeRequestId ||
      action.requestId !== current.pendingRequestId
    ) {
      return current;
    }
    return current.requestedRange
      ? {
        ...current,
        pendingRequestId: null,
      }
      : {
        activeRequestId: current.activeRequestId,
        pendingRequestId: null,
        requestedRange: null,
        fullRange: current.fullRange,
        fullData: action.data,
      };
  }

  if (action.type === 'failed') {
    if (
      action.requestId !== current.activeRequestId ||
      action.requestId !== current.pendingRequestId
    ) {
      return current;
    }
    return {
      activeRequestId: current.activeRequestId,
      pendingRequestId: null,
      requestedRange: null,
      fullRange: current.fullRange,
      fullData: current.fullData,
    };
  }

  if (action.type === 'rendered') {
    if (action.requestId !== current.activeRequestId || current.requestedRange) {
      return current;
    }
    const range = action.naturalRange &&
      Number.isFinite(action.naturalRange.min) &&
      Number.isFinite(action.naturalRange.max) &&
      action.naturalRange.max > action.naturalRange.min
      ? { min: action.naturalRange.min, max: action.naturalRange.max }
      : null;
    return {
      activeRequestId: current.activeRequestId,
      pendingRequestId: current.pendingRequestId,
      requestedRange: null,
      fullRange: range,
      fullData: current.fullData,
    };
  }

  return {
    activeRequestId: current.activeRequestId,
    pendingRequestId: null,
    requestedRange: null,
    fullRange: current.fullRange,
    fullData: current.fullData,
  };
}

export function chartZoomRangeKey(range: ChartZoomRange): string {
  return String(Number(range.min)) + ':' + String(Number(range.max));
}

/**
 * Coalesces repeated notifications for one completed zoom without dropping two
 * genuinely distinct zooms that both finish inside the debounce window.
 */
export function chartZoomAutoRefineQueueAction(
  scheduledRange: ChartZoomRange | null | undefined,
  nextRange: ChartZoomRange
): ChartZoomAutoRefineQueueAction {
  const next = { min: nextRange.min, max: nextRange.max };
  if (!scheduledRange) {
    return { type: 'schedule', range: next };
  }
  if (chartZoomRangeKey(scheduledRange) === chartZoomRangeKey(next)) {
    return { type: 'duplicate' };
  }
  return {
    type: 'flush',
    ranges: [
      { min: scheduledRange.min, max: scheduledRange.max },
      next,
    ],
  };
}

export function chartZoomRequestedRenderRange<T>(
  state: ChartZoomLifecycleState<T> | null | undefined
): ChartZoomRange | null {
  const range = state && state.requestedRange;
  if (!range ||
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max) ||
    range.max <= range.min) {
    return null;
  }
  return { min: range.min, max: range.max };
}

export function chartZoomRangeMatchesRequest<T>(
  state: ChartZoomLifecycleState<T> | null | undefined,
  range: ChartZoomRange | null | undefined
): boolean {
  const requested = state && state.requestedRange;
  if (!requested || !range ||
    !Number.isFinite(requested.min) ||
    !Number.isFinite(requested.max) ||
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max) ||
    requested.max <= requested.min ||
    range.max <= range.min) {
    return false;
  }
  return chartZoomRangeKey(requested) === chartZoomRangeKey(range);
}

export function chartZoomResponseIsPending<T>(
  state: ChartZoomLifecycleState<T> | null | undefined,
  requestId: number
): boolean {
  return !!state &&
    Number.isFinite(requestId) &&
    state.activeRequestId === requestId &&
    state.pendingRequestId === requestId;
}

export function chartZoomShouldRequestRange<T>(
  state: ChartZoomLifecycleState<T> | null | undefined,
  range: ChartZoomRange | null | undefined,
  lastRequestedKey = ''
): boolean {
  if (!range ||
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max) ||
    range.max <= range.min) {
    return false;
  }
  const key = chartZoomRangeKey(range);
  return key !== lastRequestedKey && !chartZoomRangeMatchesRequest(state, range);
}

export function isValidChartRange(
  value: ChartZoomRange | null | undefined
): value is ChartZoomRange {
  return !!value && Number.isFinite(value.min) && Number.isFinite(value.max) &&
    value.max > value.min;
}

/** Clamp an absolute viewport while preserving its span whenever possible. */
export function clampChartViewport(
  range: ChartZoomRange | null | undefined,
  fullRange: ChartZoomRange | null | undefined
): ChartZoomRange | null {
  if (!isValidChartRange(range) || !isValidChartRange(fullRange)) {
    return null;
  }
  const fullSpan = fullRange.max - fullRange.min;
  const requestedSpan = range.max - range.min;
  if (requestedSpan >= fullSpan) {
    return { min: fullRange.min, max: fullRange.max };
  }
  let min = range.min;
  let max = range.max;
  if (min < fullRange.min) {
    min = fullRange.min;
    max = min + requestedSpan;
  }
  if (max > fullRange.max) {
    max = fullRange.max;
    min = max - requestedSpan;
  }
  return { min, max };
}

export function panChartViewport(
  currentRange: ChartZoomRange | null | undefined,
  fullRange: ChartZoomRange | null | undefined,
  spanFraction: number
): ChartZoomRange | null {
  if (!isValidChartRange(currentRange) || !isValidChartRange(fullRange) ||
    !Number.isFinite(spanFraction)) {
    return null;
  }
  const span = currentRange.max - currentRange.min;
  const delta = span * spanFraction;
  return clampChartViewport({
    min: currentRange.min + delta,
    max: currentRange.max + delta,
  }, fullRange);
}

/** Dragging content right moves the viewed domain left. */
export function panChartViewportByPixels(
  currentRange: ChartZoomRange | null | undefined,
  fullRange: ChartZoomRange | null | undefined,
  deltaPixels: number,
  plotWidth: number
): ChartZoomRange | null {
  if (!Number.isFinite(deltaPixels) || !Number.isFinite(plotWidth) || plotWidth <= 0) {
    return null;
  }
  return panChartViewport(currentRange, fullRange, -deltaPixels / plotWidth);
}

export type ChartNavigatorPart = 'window' | 'start' | 'end';

export interface ChartNavigatorWindow {
  startFraction: number;
  endFraction: number;
}

export interface ChartNavigatorSliderRange {
  minimum: number;
  maximum: number;
  now: number;
}

export interface ChartNavigatorSliderBounds {
  window: ChartNavigatorSliderRange;
  start: ChartNavigatorSliderRange;
  end: ChartNavigatorSliderRange;
}

/** Count sampled X values inside an absolute viewport. */
export function chartVisibleSampledPointCount(
  xValues: readonly number[] | null | undefined,
  range: ChartZoomRange | null | undefined
): number {
  if (!xValues || !isValidChartRange(range)) return 0;
  let count = 0;
  for (const value of xValues) {
    if (Number.isFinite(value) && value >= range.min && value <= range.max) count += 1;
  }
  return count;
}

/** Convert an absolute X range into a clamped navigator window. */
export function chartNavigatorWindow(
  range: ChartZoomRange | null | undefined,
  fullRange: ChartZoomRange | null | undefined
): ChartNavigatorWindow | null {
  if (!isValidChartRange(range) || !isValidChartRange(fullRange)) return null;
  const clamped = clampChartViewport(range, fullRange);
  if (!clamped) return null;
  const span = fullRange.max - fullRange.min;
  return {
    startFraction: Math.max(0, Math.min(1, (clamped.min - fullRange.min) / span)),
    endFraction: Math.max(0, Math.min(1, (clamped.max - fullRange.min) / span)),
  };
}

/** Move one navigator edge or the whole window by a fraction of the full domain. */
export function adjustChartNavigatorRange(
  range: ChartZoomRange | null | undefined,
  fullRange: ChartZoomRange | null | undefined,
  part: ChartNavigatorPart,
  deltaFraction: number,
  minimumSpanFraction = 0.001
): ChartZoomRange | null {
  if (!isValidChartRange(range) || !isValidChartRange(fullRange) || !Number.isFinite(deltaFraction)) return null;
  if (part === 'window') {
    const selectedFraction = (range.max - range.min) / (fullRange.max - fullRange.min);
    return panChartViewport(range, fullRange, deltaFraction / selectedFraction);
  }
  const fullSpan = fullRange.max - fullRange.min;
  const minimumSpan = Math.max(
    Number.EPSILON * Math.max(1, Math.abs(fullRange.min), Math.abs(fullRange.max)),
    fullSpan * Math.max(0, minimumSpanFraction)
  );
  if (part === 'start') {
    return {
      min: Math.max(fullRange.min, Math.min(range.max - minimumSpan, range.min + fullSpan * deltaFraction)),
      max: range.max,
    };
  }
  return {
    min: range.min,
    max: Math.min(fullRange.max, Math.max(range.min + minimumSpan, range.max + fullSpan * deltaFraction)),
  };
}

/** Center the current window on a navigator fraction without changing its span. */
export function recenterChartNavigatorRange(
  range: ChartZoomRange | null | undefined,
  fullRange: ChartZoomRange | null | undefined,
  centerFraction: number
): ChartZoomRange | null {
  if (!isValidChartRange(range) || !isValidChartRange(fullRange) || !Number.isFinite(centerFraction)) return null;
  const fullSpan = fullRange.max - fullRange.min;
  const span = range.max - range.min;
  const center = fullRange.min + Math.max(0, Math.min(1, centerFraction)) * fullSpan;
  return clampChartViewport({ min: center - span / 2, max: center + span / 2 }, fullRange);
}

/** ARIA slider bounds for the navigator's window and edge controls. */
export function chartNavigatorSliderBounds(
  range: ChartZoomRange | null | undefined,
  fullRange: ChartZoomRange | null | undefined
): ChartNavigatorSliderBounds | null {
  const window = chartNavigatorWindow(range, fullRange);
  if (!window) return null;
  const start = Math.round(window.startFraction * 1000);
  const end = Math.round(window.endFraction * 1000);
  return {
    window: { minimum: 0, maximum: 1000, now: Math.round((start + end) / 2) },
    start: { minimum: 0, maximum: Math.max(0, end - 1), now: start },
    end: { minimum: Math.min(1000, start + 1), maximum: 1000, now: end },
  };
}
