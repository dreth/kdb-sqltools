/**
 * Reconciles the identities hidden through a chart legend with the identities
 * currently rendered. Hidden identities absent from a temporary render are
 * retained so refinement and configuration round-trips cannot make them visible.
 */
export function updateHiddenChartSeriesKeys(
  previousHiddenKeys: readonly string[],
  renderedKeys: readonly string[],
  hiddenRenderedKeys: readonly string[]
): string[] {
  const rendered = new Set(renderedKeys);
  const next = new Set(previousHiddenKeys.filter(key => !rendered.has(key)));
  for (const key of hiddenRenderedKeys) {
    if (rendered.has(key)) {
      next.add(key);
    }
  }
  return Array.from(next);
}

export function chartLegendToggleKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}
