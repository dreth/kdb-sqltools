# Charting

The kdb results panel includes a first built-in chart tool: a line/time-series chart for the current visible result.

SQLTools remains required for connections and q execution. Charting uses the current kdb results panel data, not SQLTools' result-grid row objects.

## Open a chart

1. Run q into a kdb results panel.
2. Open `Tools`.
3. Select `Line chart`.
4. Pick one x column and one or more y columns.
5. Press `Render`.
6. Use the cursor tooltip/crosshair, drag across the plot to zoom, or press `Reset zoom`.
7. After the chart renders, press `Export PNG` to save the chart as `kdb-chart.png` or another PNG file.

uPlot powers the built-in chart. Supported interactions are cursor/crosshair tooltip values, drag-select zoom, reset zoom, legend labels with live values, legend series toggling, and PNG export.

Only line charts are supported. Bar, pie, heatmap, dashboard, streaming, and pan features are not implemented. Zoom is applied to the sampled points already in the webview; it does not request a newly sampled viewport from the extension host yet.

## Eligible columns

The chart tool uses visible columns only.

| Role | Eligible data |
| --- | --- |
| x | Numeric values or temporal strings such as dates, timestamps, months, and times. |
| y | Numeric values. |

When q type metadata is unavailable, the extension samples column values and infers eligibility. Symbol, category, nested list, object, and mixed incompatible columns are rejected for this first chart.

If x values are unsorted, the extension sorts a chart-local copy. The table order is not changed.

## Downsampling

Downsampling happens in the extension host before data is sent to the webview.

Before downsampling, charting scans source rows in the extension host. `kdb-sqltools.results.kdbPanel.chartMaxSourceRows` controls the source-row guard. It defaults to `2000000`, has a minimum of `1`, and has no hard upper bound. Chart requests above the configured value are rejected before scanning.

Very large values can make chart rendering slow or temporarily block the extension host, especially with multiple y columns. For very large data, prefer the local data server or sliced results.

The target point count is based on chart width, roughly three points per horizontal pixel, capped at a safe maximum. Large inputs use min/max bucket sampling to preserve local spikes better than uniform stride.

The chart response includes:

- source row count
- eligible row count
- sampled point count
- sampling algorithm
- warnings such as sorted x values or dropped invalid x values

Null and non-finite y values render as line gaps where sampled. Rows with null, non-finite, or incompatible x values are dropped from the chart.

## Implementation note

The chart uses uPlot from local extension assets. The VS Code webview loads the minified uPlot JavaScript and CSS from the packaged extension so charting works offline and remains under the extension CSP.

PNG export saves the rendered uPlot canvas through the extension host, not browser download APIs inside the webview.

For richer Plotly workflows, use the [local data server](local-data-server.md) from Python or pandas. `plotly-resampler` fits that external workflow better than the built-in webview chart.
