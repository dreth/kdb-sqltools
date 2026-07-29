# Charting

The kdb results panel includes a compact built-in chart tool for the current visible result.

SQLTools remains required for connections and q execution. Charting uses the current kdb results panel data, not SQLTools' result-grid row objects.

## Open a chart

1. Run q into a kdb results panel.
2. Press the top-level `Chart` button.
3. Pick `Line`, `Scatter`, `Step`, `Bar`, `Box`, or `Candlestick` from the single `Chart type` selector.
4. Pick one numeric or temporal x column.
5. For line, scatter, step, bar, or box, pick one or more numeric y columns. For candlestick, instead pick four distinct numeric columns in the explicit `Open`, `High`, `Low`, and `Close` selectors.
6. Optionally pick a categorical `Group by` column for line, scatter, step, or bar. Box and candlestick do not support grouping, so the control is hidden and the chart status explains why.
7. Press `Render`.
8. Use the cursor tooltip/crosshair, drag across the plot to zoom (including repeated nested zooms), press `Refine zoom` to resample the current zoom range, or press `Reset zoom`.
9. After the chart renders, press `Export PNG` to save the chart as `kdb-chart.png` or another PNG file.

Changing the chart type updates control visibility, defaults, validation, and the compact status immediately. It does not remove the currently rendered chart. The panel shows `Chart settings changed — Render to update` until you press `Render`; export still applies to the rendered chart.

uPlot powers the built-in chart. Supported interactions are cursor/crosshair tooltip values, drag-select zoom, debounced zoom refinement, explicit zoom refinement, reset zoom, legend labels with live values, legend series toggling, splitter resizing between chart and table, and PNG export. Each distinct completed drag zoom requests the newly selected absolute range from the retained full source, including a second or later zoom nested inside a refined response. Duplicate scale notifications are debounced/deduplicated, while reconstruction, resize, settings, and series-visibility rerenders do not recursively issue refinement requests.

`Reset zoom` invalidates in-flight refinements, restores the immutable original full sample and x-range, and disables again at that baseline without another q/backend request. A late stale response cannot replace the restored baseline. Candlestick uses a dedicated uPlot canvas hook so its wicks and bodies participate in the same zoom, reset, refinement, and PNG export path.

X-axis labels are auto-thinned to keep dense numeric and timestamp axes readable while preserving useful grid lines where possible. Timestamp labels use shorter adaptive formats after zoom, and edge labels may be suppressed to avoid clipping. Hover and cursor/crosshair tooltip values still show the precise x value for the selected point.

`kdb-sqltools.results.kdbPanel.chartDecimalPlaces` controls chart numeric precision for numeric x/y tick labels, tooltip values, legend/live values, box-stat labels, and candlestick OHLC values. It defaults to `4` and accepts `0` through `12`. Very large or very small nonzero values use scientific notation with the configured precision so they do not silently round to `0`. Temporal timestamp labels do not use this numeric decimal formatting.

Chart selections are saved only after a successful render, using the visible column names and order as the signature. Later results restore the chart type and only the roles that remain valid for compatible columns, including after VS Code restarts. Candlestick persistence includes x plus all four OHLC roles. Older generic selections and selections whose columns changed fall back safely instead of being reinterpreted as OHLC.

`kdb+: Run Selection and Chart` runs the selected text, or the current physical line when nothing is selected, into the kdb panel and opens/renders the chart panel. `kdb+: Run Selection or q Block and Chart` uses the current q block bounded by blank lines when nothing is selected. Both commands use restored chart selections when available; otherwise they render the current default eligible columns. Replacing a result in a panel that already had a rendered chart also re-renders the chart when the new result columns are compatible.

## Type support

The controls and renderer are deliberately type-specific. There are no line or area settings that masquerade as another chart type.

| Chart type | x | Value controls | Group by | Behavior |
| --- | --- | --- | --- | --- |
| Line | Numeric or temporal | One or more numeric y columns | Yes | Generic numeric lines; null/non-finite values form gaps. |
| Scatter | Numeric or temporal | One or more numeric y columns | Yes | Points only, without connecting line or area semantics. |
| Step | Numeric or temporal | One or more numeric y columns | Yes | Generic numeric stepped lines; null/non-finite values form gaps. |
| Bar | Numeric or temporal | One or more numeric y columns | Yes | Selected and grouped series form side-by-side clusters around each x position. |
| Box | Numeric or temporal | One or more numeric y columns | No | Computes min, q1, median, q3, and max per x value or sampling bucket. |
| Candlestick | Numeric or temporal | Four distinct numeric Open, High, Low, and Close columns | No | Draws financial wicks and bodies from one coordinated OHLC model. |

`Group by` splits each selected y column into a separate series per categorical value for line, scatter, step, and bar. The extension caps the number of categories and generated series and shows a status warning if the result exceeds those limits. Box and candlestick neither show nor accept `Group by`; they never silently treat a categorical group value as x.

Box buckets keep each selected numeric y series together for min, q1, median, q3, and max. A multi-x bucket is positioned at the midpoint of its first and last sorted x value, while the response preserves the full source x minimum/maximum so irregular numeric or temporal ranges remain reachable by zoom and reset. If side-by-side boxes are too dense to distinguish, the renderer skips them with a clear status instead of overlapping them.

## Candlestick requirements

Candlestick is a real OHLC chart, not four generic lines. Its normal y-column checklist is hidden. Select all of these roles explicitly:

- `Open`: numeric opening value.
- `High`: numeric high value.
- `Low`: numeric low value.
- `Close`: numeric closing value.

The four selectors must name four distinct visible numeric columns. Missing, duplicate, categorical, temporal, nested, object, or otherwise non-numeric OHLC selections reject the render with an actionable error.

Rows with an invalid x value follow the normal x rule and are removed before candle validation. Every retained candle row must contain finite numeric OHLC values and satisfy all of these conditions:

- `high >= open`
- `high >= close`
- `low <= open`
- `low <= close`
- `high >= low`

If any retained row fails, the whole candlestick render is rejected with a row/column-oriented error. Values are not reordered, inferred from y-checklist order, silently dropped, or otherwise reinterpreted.

Candlestick downsampling keeps the roles together. It divides the numeric or temporal x domain into bounded intervals; for each non-empty x bucket it uses the first valid open, maximum high, minimum low, and last valid close in x order while preserving source order for duplicate x values. An aggregate is positioned at the midpoint of its first and last source x, and the response preserves the full source x minimum/maximum so irregular ranges remain correctly scaled and reachable by zoom. It never independently min/max-samples the four columns as unrelated series. The initial full-range result remains capped at roughly one candle per horizontal pixel; zoom refinement applies the shared 3,000/7,000 range-density contract while retaining the same coordinated financial aggregation when reduction is required.

The canvas hook draws a wick from low to high and a width-clamped body from open to close. Up and down candles use predictable contrasting colors plus hollow/filled bodies so direction remains distinguishable in light and dark webview themes without relying on color alone. Dense x ranges retain a legible positive body width. The cursor tooltip shows x, open, high, low, and close, and PNG export includes the rendered candles.

## Bar behavior

Bars use their own clustered drawing path rather than line or filled-area semantics. At each x position, every selected y series and generated group series receives a side-by-side slot; series do not overlap one another.

Cluster width comes from actual positive x spacing in plot coordinates and is clamped to a positive visible range. Compatible duplicate-x rows align into one cluster; multiple finite values for the same selected or grouped series at one x are rejected as ambiguous and must be aggregated in q. Non-increasing or otherwise degraded local spacing never produces a zero-width, negative-width, or misleading overlapping bar. If a cluster is too dense to distinguish safely, it is skipped with a clear status; zoom refinement can recover more detail for a smaller range.

The bar y scale always includes zero. Positive values extend upward from zero and negative values extend downward. Null and non-finite y values are skipped and reported rather than converted to zero.

## Eligible columns

The chart tool uses visible columns only.

| Role | Eligible data |
| --- | --- |
| x | Numeric values or temporal strings such as dates, timestamps, months, and times. Categorical values are not silently promoted to x. |
| generic y | Numeric values for line, scatter, step, bar, and box. |
| Open, High, Low, Close | Four distinct numeric columns for candlestick. |
| Group by | Categorical scalar columns for line, scatter, step, and bar only, inferred from visible non-numeric, non-temporal values such as symbols or labels. |

When q type metadata is unavailable, the extension samples column values and infers eligibility. Nested list, object, and mixed incompatible columns are rejected. If x values are unsorted, the extension sorts a chart-local copy; the table order is not changed. Grouped line, scatter, step, and bar rows align by x so every category has one tooltip position; categories without finite selected y values are omitted, and multiple finite values for the same generated series and x are rejected as ambiguous.

## Downsampling

Downsampling happens in the extension host before data is sent to the webview.

Before downsampling, charting scans source rows in the extension host. `kdb-sqltools.results.kdbPanel.chartMaxSourceRows` controls the source-row guard. It defaults to `2000000`, has a minimum of `1`, and has no hard upper bound. Chart requests above the configured value are rejected before scanning.

Very large values can make chart rendering slow or temporarily block the extension host, especially with multiple y columns. For very large data, prefer the local data server or sliced results.

The initial full-range target point count is based on chart width and capped at a safe maximum. Line, scatter, and step target roughly three points per horizontal pixel and use min/max bucket sampling to preserve local spikes and representative source gaps better than uniform stride. Bar first consolidates every compatible selected/grouped series into a complete distinct-x cluster, then evenly thins whole clusters when needed. Box uses coordinated min/q1/median/q3/max statistics for each selected numeric y series; groups too dense for side-by-side boxes are skipped with a status rather than overlapped. Candlestick targets roughly one candle per horizontal pixel and uses coordinated first-open/max-high/min-low/last-close financial buckets.

Zoom refinement scans the same guarded full source result and resamples only the selected absolute x range. Every genuinely distinct completed drag zoom starts a fresh request, even when the previous refined response was exact or used a different reduction model. Requests are normally debounced for about 450 ms. If two distinct drags finish inside that window, the queued range is flushed and both absolute ranges are issued; a nested drag completed while another refinement is in flight supersedes it immediately so the older response cannot erase the newer intent. Identical scale notifications are deduplicated, and scale changes caused by response reconstruction, resize, settings, or hide/show rerenders are suppressed. The `Refine zoom` button always requests the current zoom range explicitly. The webview does not rescan on mousemove.

The fixed refined-range density contract is:

- Fewer than 3,000 eligible source rows: render every available row; never invent or upsample points.
- From 3,000 through 7,000 eligible rows: retain all available density without forced reduction.
- Above 7,000 eligible rows: use the chart type's reduction model to return about 7,000 points, with only explicitly bounded algorithmic overshoot.

Type-specific semantic consolidation still applies before density is counted: duplicate x rows that form one bar cluster or OHLC candle are not split into invented visual points. The contract retains every available type-valid point after that required consolidation.

The legacy `kdb-sqltools.results.kdbPanel.chartZoomMinSampledPoints` and `kdb-sqltools.results.kdbPanel.chartZoomMaxSampledPoints` keys remain only as deprecated compatibility entries. They are ignored so user or workspace overrides cannot weaken the fixed density contract. The exact eligible row count for each absolute zoom range is computed from the retained full source. The chart status shows both eligible and full-source row counts so repeated refinement can be verified directly.

The chart response includes:

- source row count
- eligible row count
- sampled point or candle count
- sampling algorithm
- warnings such as sorted x values, dropped invalid x values, or skipped dense bar/box groups

For generic charts, null and non-finite y values render as gaps for line/step and are skipped for scatter/bar/box statistics. Candlestick uses the stricter all-OHLC row validation described above. Rows with null, non-finite, or incompatible x values are dropped from every chart type.

## Implementation note

The chart uses uPlot from local extension assets. The VS Code webview loads the minified uPlot JavaScript and CSS from the packaged extension so charting works offline and remains under the extension CSP. The extension retains the original full source/sample independently from refined responses so nested requests and reset never use a previous reduced response as their baseline. Candlestick wicks/bodies, clustered bars, and box summaries use dedicated canvas drawing paths rather than fake generic line series.

The zoom lifecycle was compared directly with the known-good 0.3.15 commit `f7af079`. That version did not restrict nested refinement by the current sampling algorithm. Later candlestick hardening added an algorithm eligibility gate and tightened the existing visible-density gate, which could suppress a second drag after an exact or differently reduced response. Commit `f58aca9` introduced the valuable reducer lifecycle with immutable `fullData`/`fullRange`, explicit `requestedRange`, response reconstruction, and stale-request deduplication while retaining those gates. It also seeded `fullRange` only from uPlot's scale immediately after construction; uPlot can commit that scale asynchronously, leaving the baseline null and causing a real drag to be treated as unzoomed. The current lifecycle falls back to the full data domain when seeding that baseline and removes the suppressing gates without reverting candlestick sampling, hidden-series state, stale-response invalidation, response reconstruction, or reset improvements.

PNG export saves the rendered uPlot canvas through the extension host, including custom bars, boxes, and candles, not browser download APIs inside the webview.

For richer Plotly workflows, use the [local data server](local-data-server.md) from Python or pandas. `plotly-resampler` fits that external workflow better than the built-in webview chart.
