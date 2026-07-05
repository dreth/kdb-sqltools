# Charting

The kdb results panel includes a compact built-in chart tool for the current visible result.

SQLTools remains required for connections and q execution. Charting uses the current kdb results panel data, not SQLTools' result-grid row objects.

## Open a chart

1. Run q into a kdb results panel.
2. Press the top-level `Chart` button.
3. Pick a chart type from the single `Chart type` selector: `Line`, `Scatter`, `Step`, `Bar`, or `Box`.
4. Pick one x column, optionally pick `Group by`, and pick one or more y columns in the chart panel.
5. Press `Render`.
6. Use the cursor tooltip/crosshair, drag across the plot to zoom, press `Refine zoom` to resample the current zoom range, or press `Reset zoom`.
7. After the chart renders, press `Export PNG` to save the chart as `kdb-chart.png` or another PNG file.

Changing chart settings does not remove the currently rendered chart. The panel shows `Chart settings changed — Render to update` until you press `Render`; export still applies to the rendered chart.

uPlot powers the built-in chart. Supported interactions are cursor/crosshair tooltip values, drag-select zoom, debounced zoom refinement, explicit zoom refinement, reset zoom, legend labels with live values, legend series toggling, splitter resizing between chart and table, and PNG export. `Reset zoom` restores the full rendered x domain immediately from the data already in the webview; it does not rescan or re-request chart data.

X-axis labels are auto-thinned to keep dense numeric and timestamp axes readable while preserving useful grid lines where possible. Timestamp labels use shorter adaptive formats after zoom, and edge labels may be suppressed to avoid clipping. Hover and cursor/crosshair tooltip values still show the precise x value for the selected point.

`kdb-sqltools.results.kdbPanel.chartDecimalPlaces` controls chart numeric precision for numeric x/y tick labels, tooltip values, legend/live values, and box-stat labels. It defaults to `4` and accepts `0` through `12`. Very large or very small nonzero values use scientific notation with the configured precision so they do not silently round to `0`. Temporal timestamp labels do not use this numeric decimal formatting.

Chart selections are saved after a successful render using the visible column names and order as the signature. Later results with the same compatible columns restore chart type, x column, y columns, and group-by selection, including after VS Code restarts.

`kdb+: Run Selection and Chart` runs the selected text, or the current q block when nothing is selected, into the kdb panel and opens/renders the chart panel. It uses restored chart selections when available; otherwise it renders the current default eligible columns. Replacing a result in a panel that already had a rendered chart also re-renders the chart when the new result columns are compatible.

Supported chart types are intentionally compact: line, scatter, step, bar, and box. Scatter uses points without line clutter. Step uses stepped lines. Bar uses uPlot bar paths. Box plots compute per-x/bucket min, quartiles, median, and max for selected numeric y columns and draw those summaries over the sampled x axis. Pie, heatmap, dashboard, streaming, and pan features are not implemented.

## Eligible columns

The chart tool uses visible columns only.

| Role | Eligible data |
| --- | --- |
| x | Numeric values or temporal strings such as dates, timestamps, months, and times. |
| y | Numeric values. Box plots summarize selected numeric y columns per x value/bucket. |
| group by | Categorical scalar columns inferred from visible non-numeric, non-temporal values, such as symbols or labels. |

When q type metadata is unavailable, the extension samples column values and infers eligibility. Symbol/category-like columns are eligible for `Group by`; nested list, object, and mixed incompatible columns are rejected.

`Group by` is available for line, scatter, step, and bar charts. It splits each selected y column into per-category uPlot series, capped to a small number of categories/series with a status warning when there are too many. Box charts do not support `Group by`.

If x values are unsorted, the extension sorts a chart-local copy. The table order is not changed.

## Downsampling

Downsampling happens in the extension host before data is sent to the webview.

Before downsampling, charting scans source rows in the extension host. `kdb-sqltools.results.kdbPanel.chartMaxSourceRows` controls the source-row guard. It defaults to `2000000`, has a minimum of `1`, and has no hard upper bound. Chart requests above the configured value are rejected before scanning.

Very large values can make chart rendering slow or temporarily block the extension host, especially with multiple y columns. For very large data, prefer the local data server or sliced results.

The initial full-range target point count is based on chart width, roughly three points per horizontal pixel, capped at a safe maximum. Large inputs use min/max bucket sampling to preserve local spikes better than uniform stride.

Zoom refinement scans the same guarded source result and resamples only the selected x range. A settled drag zoom starts one debounced auto-refine after about 450 ms only when the currently visible sampled points are below `kdb-sqltools.results.kdbPanel.chartZoomMinSampledPoints` and the rendered chart has more eligible rows than those visible sampled points. The `Refine zoom` button always requests the current zoom range explicitly. The webview does not rescan on mousemove, and the extension remembers the last auto-refined range to avoid loops.

`kdb-sqltools.results.kdbPanel.chartZoomMinSampledPoints` defaults to `3000` and has a minimum of `1`. `kdb-sqltools.results.kdbPanel.chartZoomMaxSampledPoints` defaults to `7000`; values below the min setting are clamped up to the min. If the source rows eligible in the zoomed x range are at or below the max, refinement returns all of them. If there are more, it min/max samples to the max. The exact eligible row count for a zoom range is known after the refine request and is shown in the chart status.

The chart response includes:

- source row count
- eligible row count
- sampled point count
- sampling algorithm
- warnings such as sorted x values or dropped invalid x values

Null and non-finite y values render as gaps for line/step charts and are skipped for scatter/bar/box statistics where sampled. Rows with null, non-finite, or incompatible x values are dropped from the chart.

## Implementation note

The chart uses uPlot from local extension assets. The VS Code webview loads the minified uPlot JavaScript and CSS from the packaged extension so charting works offline and remains under the extension CSP.

PNG export saves the rendered uPlot canvas through the extension host, not browser download APIs inside the webview.

For richer Plotly workflows, use the [local data server](local-data-server.md) from Python or pandas. `plotly-resampler` fits that external workflow better than the built-in webview chart.
