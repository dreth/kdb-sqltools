# Charting Roadmap

!!! note "Current status"

    The first built-in line/time-series chart and the opt-in local data server have shipped. See [Charting](charting.md) and [Local data server](local-data-server.md) for user-facing behavior. This page now tracks future charting direction.

## Current status

The extension currently supports q execution, the kdb results panel, copy/export, an opt-in local data server, and a first built-in line/time-series chart with PNG export.

Future charting work should stay focused on large kdb time-series results rather than small demo datasets. The design should continue to avoid sending millions of raw points to a VS Code webview.

## Library recommendation

| Tool | Recommended role | Notes |
| --- | --- | --- |
| uPlot | Next built-in VS Code charting candidate. | Lightweight and fast for line and time-series charts. It keeps the webview dependency small, but the extension must own data shaping, downsampling, legends, and richer interactions. |
| ECharts | Rich fallback or prototype candidate. | Larger than uPlot, but useful for comparing tooltips, zoom, legends, mixed chart types, and polished interactions before committing to custom uPlot work. |
| Plotly and plotly-resampler | External Python/pandas workflow through a future local data server. | `plotly-resampler` is strongest in Python workflows where pandas/NumPy data and callback-driven viewport updates are natural. Pulling Plotly.js into the built-in webview first would add a heavier dependency before proving that the extension needs Plotly-specific chart features. |

The default built-in path should be uPlot-first for fast time-series. ECharts is the practical fallback if the first-class UX needs richer built-in interactions. Plotly should stay available through external workflows rather than becoming the first webview dependency.

## Local data server

The local data server is now the external-workflow path for pandas, Plotly, and `plotly-resampler`. Future server work can add richer metadata and streaming or chunked workflows if needed.

That path makes `plotly-resampler` useful where it fits best: Python analysis using pandas dataframes and dynamic Plotly figures.

## uPlot resampling design

The extension should downsample before data reaches the webview. The webview should receive a viewport-sized series plus metadata, not a full multi-million point result.

### Data model

- Use the extension's columnar result store as the source for chart arrays.
- Require one x column, preferably temporal or numeric, and one or more numeric y columns.
- For combined results, require a common compatible x/time column.
- Prefer already sorted x data.
- If x is unsorted, build a sorted index or copied sorted arrays for the chart operation without mutating the result table.
- Reject or defer symbol/category x axes for the first version.

### Viewport-aware sampling

Sampling should be driven by the visible x range and panel width:

1. Determine the current chart viewport, `xMin` to `xMax`.
2. Estimate the target point count from the plot width, for example 2 to 4 points per horizontal CSS pixel.
3. Read only the x-range window from the columnar store or sorted index.
4. Downsample each y series into that target.
5. Send the sampled x/y arrays, source row counts, algorithm name, x range, and flags such as nulls or clipped infinities to the webview.

Zooming and panning should request a new sampled window. The raw full result should stay extension-side.

### Algorithms

Initial candidates:

- Min/max bucket sampling to preserve spikes and local extremes.
- LTTB or MinMaxLTTB to preserve visual shape better than uniform stride.

Later candidates:

- Average buckets for aggregate views.
- OHLC buckets for price-style data.
- User-selectable sampling modes where the result semantics make that worthwhile.

Uniform stride should not be the default for large time-series because it can hide short spikes.

### Edge cases

The first implementation should define behavior for:

- Null y values.
- Positive and negative infinity.
- Duplicate timestamps.
- Unsorted x values.
- Mixed temporal units or incompatible x columns across results.
- Very sparse ranges where downsampling is unnecessary.
- Very dense ranges where many source rows collapse into one pixel bucket.
- Non-numeric y columns.

Symbols, categories, nested lists, and general object columns should not be eligible for the first built-in line chart.

### Responsiveness

Large resampling jobs should use cancellation and versioning:

- Each chart request gets a result version and viewport version.
- Old work is cancelled or ignored when a newer zoom, pan, sort, rerun, or result tab switch arrives.
- CPU-heavy work should yield or run in workers where practical.
- The webview should show sampled-count metadata so users know they are seeing a downsampled view.

## Build phases

1. Local data server. Shipped.
   - Serve current result, selection, visible columns, row slices, and metadata from localhost.
   - Document Python/pandas usage, including Plotly and plotly-resampler workflows.
   - Keep the server opt-in and guarded by tokenized URLs.
2. Charting spike.
   - Compare uPlot, ECharts, and Plotly.js inside a VS Code webview.
   - Benchmark bundle size, first render, zoom/pan latency, tooltip behavior, memory, and extension-to-webview transfer cost.
   - Test small, medium, and large time-series results with and without downsampling.
3. First built-in chart. Shipped in bounded form.
   - Line/time-series only.
   - User selects one x column and one or more y columns.
   - Auto downsampling based on plot width and visible x range.
   - Basic tooltip, legend, and sampled/full row-count metadata.
   - PNG export for the rendered canvas.
4. Docs and tests.
   - Update user docs for any shipped charting behavior.
   - Add fixtures for sorted and unsorted x values, nulls, infinities, duplicate timestamps, and dense ranges.
   - Add performance checks for large result downsampling.
   - Keep table copy/export semantics separate from chart export semantics.

## Non-goals for the first built-in chart

- General BI dashboarding.
- Category, bar, pie, heatmap, or nested data charts.
- Streaming live updates.
- Plotly.js as the default built-in dependency.
- Sending complete million-row series to the webview by default.
