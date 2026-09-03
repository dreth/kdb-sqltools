export const DEFAULT_LARGE_SORT_WARNING_ROW_THRESHOLD = 5_000_000;
export const MIN_LARGE_SORT_WARNING_ROW_THRESHOLD = 1;
export const MAX_LARGE_SORT_WARNING_ROW_THRESHOLD = 2_147_483_647;

export interface LargeSortWarningOptions {
  rowThreshold?: unknown;
  hideWarnings?: boolean;
  approved?: boolean;
}

export interface ResultSortWarningIdentity<Identity> {
  readonly identity: Identity;
  readonly generation: number;
}

export function normalizeLargeSortWarningRowThreshold(
  value: unknown,
  fallback: unknown = DEFAULT_LARGE_SORT_WARNING_ROW_THRESHOLD
): number {
  const normalizedFallback = validLargeSortWarningRowThreshold(fallback)
    ? fallback
    : DEFAULT_LARGE_SORT_WARNING_ROW_THRESHOLD;
  return validLargeSortWarningRowThreshold(value)
    ? value
    : normalizedFallback;
}

export function shouldWarnForLargeSort(
  rowCount: unknown,
  options: LargeSortWarningOptions = {}
): boolean {
  if (options.hideWarnings === true || options.approved === true ||
    !validResultRowCount(rowCount)) {
    return false;
  }
  return rowCount > normalizeLargeSortWarningRowThreshold(options.rowThreshold);
}

/**
 * Tracks approval for one displayed result at a time. Call replace whenever a
 * new result is displayed and retain the returned token while awaiting user
 * confirmation. Approval with an older token fails closed, including when a
 * replacement reuses the same caller-provided identity.
 */
export class ExactResultSortWarningApproval<Identity> {
  private generation = 0;
  private currentIdentity: ResultSortWarningIdentity<Identity> | undefined;
  private approvedIdentity: ResultSortWarningIdentity<Identity> | undefined;

  public replace(identity: Identity): ResultSortWarningIdentity<Identity> {
    const next = {
      identity,
      generation: ++this.generation,
    };
    this.currentIdentity = next;
    this.approvedIdentity = undefined;
    return next;
  }

  public clear(): void {
    this.generation += 1;
    this.currentIdentity = undefined;
    this.approvedIdentity = undefined;
  }

  public current(): ResultSortWarningIdentity<Identity> | undefined {
    return this.currentIdentity;
  }

  public isCurrent(identity: ResultSortWarningIdentity<Identity>): boolean {
    return identity === this.currentIdentity;
  }

  public approve(identity: ResultSortWarningIdentity<Identity>): boolean {
    if (!this.isCurrent(identity)) {
      return false;
    }
    this.approvedIdentity = identity;
    return true;
  }

  public isApproved(
    identity: ResultSortWarningIdentity<Identity> | undefined = this.currentIdentity
  ): boolean {
    return identity !== undefined &&
      identity === this.currentIdentity &&
      identity === this.approvedIdentity;
  }
}

function validLargeSortWarningRowThreshold(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_LARGE_SORT_WARNING_ROW_THRESHOLD &&
    value <= MAX_LARGE_SORT_WARNING_ROW_THRESHOLD;
}

function validResultRowCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
