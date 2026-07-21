# Charting Roadmap

!!! note "Current status"

    Built-in line, scatter, step, clustered bar, box, and real OHLC candlestick charts have shipped, together with extension-side sampling and zoom refinement. See [Charting](charting.md) for the supported controls and validation rules. This page tracks architectural boundaries and future work rather than promising additional chart types.

## Current architecture

The built-in renderer is uPlot-first and optimized for numeric or temporal x data from the kdb results panel. The extension host owns eligibility checks, sorting, grouping, validation, and type-aware data reduction before bounded chart data enters the webview.

Line, scatter, and step use generic selected numeric y series. Bar uses a dedicated clustered canvas path so selected and grouped series render side by side with positive clamped widths and a zero baseline. Box uses selected numeric y series to compute min, q1, median, q3, and max. Candlestick uses explicit, distinct numeric Open, High, Low, and Close roles and a dedicated wick/body canvas path; it is not four line series.

`Group by` is implemented only for line, scatter, step, and bar. Box and candlestick do not expose it. Every type requires numeric or temporal x; categorical group values are not silently reused as x.

## Renderer roles

| Tool | Role | Notes |
| --- | --- | --- |
| uPlot | Shipped built-in VS Code chart renderer | Keeps the webview dependency small and provides axes, cursor, legend, zoom state, canvas composition, and PNG export. Dedicated hooks draw clustered bars, box summaries, and candlesticks. |
| ECharts | Prototype fallback only | Consider only if a future verified requirement cannot be implemented safely with the existing uPlot architecture. It is not a current dependency. |
| Plotly and plotly-resampler | External Python/pandas workflow | Use the opt-in local data server for richer external analysis rather than adding Plotly.js to the built-in webview. |

No additional renderer dependency should be added without a concrete requirement, package review, CSP/offline verification, and performance testing against representative kdb results.

## Shipped data reduction

The extension guards the number of source rows scanned, derives the initial sample target from plot width, and retains the raw result extension-side.

- Generic line, scatter, and step data uses min/max bucket sampling to preserve local extremes better than uniform stride.
- Bar data is consolidated into complete distinct-x clusters and, when necessary, evenly thinned without dropping individual series from a retained cluster.
- Box data keeps each numeric y series together long enough to compute min, q1, median, q3, and max for each x value or bucket.
- Candlestick data targets roughly one candle per horizontal pixel and uses financial aggregation: first valid open, maximum high, minimum low, and last valid close per x bucket. The four roles are never sampled independently.
- Drag zoom can request one debounced viewport refinement, and `Refine zoom` can request it explicitly. `Reset zoom` restores the original full range.

The webview receives sampled arrays plus source/eligible/sample counts, the algorithm name, and warnings. It does not rescan data on cursor movement.

## Current validation boundaries

The current chart contract intentionally stays narrow:

- x must be numeric or temporal.
- Generic y and every OHLC role must be numeric.
- Nested lists, objects, and mixed incompatible columns are rejected.
- Candlestick requires four distinct OHLC columns and rejects retained rows with missing/non-finite values or inconsistent high/low bounds.
- Bar width must come from usable positive x spacing. Compatible duplicate-x rows align into one cluster, multiple finite values for the same generated series and x are rejected, and clusters too dense to distinguish safely are skipped with a status rather than overlapped.
- Category and generated-series caps keep grouped charts bounded.

These rules prevent the renderer from inventing semantics for malformed or ambiguous data.

## Future priorities

### Responsiveness and cancellation

Continue hardening chart request versioning and cancellation so stale sorting, sampling, zoom refinement, reruns, and panel disposal do not waste extension-host work. Any CPU-heavy additions should yield or move off the critical path where practical.

### Sampling quality

Benchmark the shipped type-aware reducers on representative sorted and unsorted kdb results, duplicate timestamps, sparse and dense ranges, gaps, infinities, mixed temporal units, positive/negative bars, and large OHLC data. Consider alternative generic reducers such as LTTB only if measurements show a real improvement without weakening predictable bounds.

Candlestick aggregation must remain financial. A future reducer must preserve first open, maximum high, minimum low, and last close for every bucket.

### Visual and accessibility QA

Keep dense-axis label thinning, tooltip precision, keyboard-usable controls, light/dark theme contrast, high-DPI canvas export, and clustered bar/candle width behavior under regression coverage. Visual review should include overlapping timestamps, nearly identical x values, zero/negative bars, flat candles, and large candle counts.

### External workflows

The tokenized localhost data server remains the path for pandas, Plotly, plotly-resampler, notebooks, and other richer analysis. Future server work may add bounded metadata or chunking where a concrete external workflow requires it.

## Non-goals

- General BI dashboards.
- Invented or placeholder chart types.
- Streaming live updates in the current chart panel.
- Plotly.js as the default built-in dependency.
- Sending complete million-row series to the webview by default.
- Treating categorical, nested, or object data as numeric chart values.
