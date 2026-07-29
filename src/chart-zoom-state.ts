export interface ChartZoomRange {
  min: number;
  max: number;
}

export interface ChartZoomLifecycleState<T> {
  activeRequestId: number;
  requestedRange: ChartZoomRange | null;
  fullRange: ChartZoomRange | null;
  fullData: T | null;
}

export type ChartZoomLifecycleAction<T> =
  | { type: 'clear'; requestId: number }
  | { type: 'request'; requestId: number; range: ChartZoomRange | null }
  | { type: 'response'; requestId: number; data: T }
  | { type: 'rendered'; requestId: number; naturalRange: ChartZoomRange | null }
  | { type: 'reset' };

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
    requestedRange: null,
    fullRange: null,
    fullData: null,
  };

  if (action.type === 'clear') {
    return {
      activeRequestId: action.requestId,
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
        requestedRange: range,
        fullRange: current.fullRange,
        fullData: current.fullData,
      }
      : {
        activeRequestId: action.requestId,
        requestedRange: null,
        fullRange: null,
        fullData: null,
      };
  }

  if (action.type === 'response') {
    if (action.requestId !== current.activeRequestId) {
      return current;
    }
    return current.requestedRange
      ? current
      : {
        activeRequestId: current.activeRequestId,
        requestedRange: null,
        fullRange: current.fullRange,
        fullData: action.data,
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
      requestedRange: null,
      fullRange: range,
      fullData: current.fullData,
    };
  }

  return {
    activeRequestId: current.activeRequestId,
    requestedRange: null,
    fullRange: current.fullRange,
    fullData: current.fullData,
  };
}

export function chartZoomRangeKey(range: ChartZoomRange): string {
  return Number(range.min).toPrecision(12) + ':' + Number(range.max).toPrecision(12);
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
  return Number(requested.min).toPrecision(12) === Number(range.min).toPrecision(12) &&
    Number(requested.max).toPrecision(12) === Number(range.max).toPrecision(12);
}
