# Change Log

## 0.3.17

- Added real OHLC candlestick charts with explicit, distinct numeric `Open`, `High`, `Low`, and `Close` selectors; strict row and range validation; financial first-open/max-high/min-low/last-close bucket aggregation; and dedicated uPlot canvas rendering for candle wicks, bodies, tooltips, and PNG export.
- Audited the line, scatter, step, bar, and box controls and rendering rules. Grouped generic series now align by x and omit empty combinations, line/step sampling retains representative source gaps, bars cluster series side by side with positive clamped widths and a zero baseline, and dense boxes are skipped rather than overlapped; box and candlestick modes hide unsupported grouping controls.
- Hardened type-specific chart selection persistence so only compatible roles are restored for a matching visible-column signature and older generic selections degrade safely.

## 0.3.16

- Kept `Ctrl+Enter` / `Cmd+Enter` in `.q` editors routed to the kdb panel for both single-line and multi-line selections.
- Fixed `Reset zoom` to restore the original full chart range after manual or automatic zoom refinements.

## 0.3.15

- qText now renders normal list/object outputs fully by default, including `tables[]`-style metadata lists, with only a large character safety cap for very large output.

## 0.3.14

- Hardened SQLTools connection edit/save for stale/null driver metadata.
- Added clearer connect/handshake/query errors for reset/refused/timed-out q IPC sockets.
- Made raw q editor and kdbPanel runs honor the configured `database` namespace.

## 0.3.13

- Restored primary `Run Selection` / `Ctrl+Enter` fallback to the current physical line when nothing is selected.
- Added explicit `Run Selection or q Block` commands for blank-line-bounded block execution.
- kdb panel errors now include the connection and exact query preview.

## 0.3.12

- qText/text display strategies now render in a plain text viewer rather than a one-cell grid.
- Copy copies the plain text output directly.
- Text export writes `.txt` for text-mode results.

## 0.3.11

- Fixed Settings drawer horizontal overflow and wrapping.
- Kept Run Selection behavior on selected text or the current physical line.
- Added a promptness regression probe for local q `testConnection` and `query`.

## 0.3.10

- Added configurable q result display strategies for functions, dictionaries, lists, and object/composite values, with q-text rendering where IPC supports it and clear source-unavailable guidance for functions.
- Changed the editor title action to prefer `Run Selection` and made the kdb panel `Chart` button open the chart section directly.
- Fixed chart reset zoom and added `chartDecimalPlaces` for numeric chart ticks, tooltips, live legend values, and box statistics.
- Added zoom-range chart refinement settings with defaults of 3,000 minimum and 7,000 maximum sampled points.
- Persisted chart selections by result column signature and added `Run Selection and Chart` with `Ctrl+Alt+C` / `Cmd+Alt+C`.

## 0.3.9

- Kept rendered charts visible when chart settings change and added a `Render to update` stale-settings notice.
- Added compact `Group by` chart splitting for categorical columns on line, scatter, step, and bar charts.
- Added a draggable splitter between the chart panel and table.
- Added explicit `Refine zoom` resampling for the current x-range after zooming.
- Shortened/adapted temporal x-axis labels and suppressed edge labels to reduce timestamp overlap and clipping.

## 0.3.8

- Added a compact Chart type selector with line, scatter, step, bar, and box chart modes.
- Kept chart controls inside the existing Chart dropdown/panel so the top toolbar remains uncluttered.
- Added box-plot statistics over x values/buckets for selected numeric y columns.
- Preserved uPlot cursor, zoom, legend, x-axis label thinning, PNG export, and source-row guardrails.

## 0.3.7

- Made copy/export confirmation cell threshold configurable from Settings -> Preferences and VS Code settings.
- Made local data server full-result `current.csv`, `current.json`, and `current.ndjson` cell limit configurable from Settings -> Preferences and VS Code settings.
- Added Data server guidance for very large full-result exports.
- Made Settings sections collapsible with Preferences open and Data server collapsed by default.
- Moved Auto-fit into Preferences and enabled it by default.

## 0.3.5

- Chart x-axis labels are dynamically thinned based on chart width and label length.
- Dense timestamp/numeric axes stay readable while useful grid/tick lines can remain.
- Hover/crosshair still shows precise x values.

## 0.3.4

- Reworked the kdb results panel toolbar into one compact line.
- Moved Chart into a top-level dropdown.
- Moved Data server controls, search, auto-fit, header mode and drag/select/sort controls, hidden columns, and preferences into Settings.
- Shortened the visible cancel button to `Cancel` while retaining the full tooltip and aria label.

## 0.3.3

- Added a visible query cancellation control and running state for active kdb results panel queries.
- Made VS Code progress notifications cancellable for kdb panel query runs.
- On user cancellation, the extension closes the IPC connection, stops waiting for the query, suppresses the user-cancel error toast, and prevents stale late results from replacing newer panel output.
- Cancellation is best effort on the server side: closing the client connection stops this extension from waiting, but kdb server behavior depends on the running query and process state.

## 0.3.2

- Added a uPlot-powered built-in line chart renderer for eligible time-series-style result data.
- Added cursor/crosshair tooltips, drag-select zoom, reset zoom, and live legend values with series toggling.
- Preserved PNG export from the rendered uPlot canvas.
- Packaged uPlot assets locally for offline use with no CDN dependency.
- Current chart limitations: line/time-series rendering only, no pan or full dashboard experience, and zoom uses the already sampled webview data rather than viewport-aware resampling.

## 0.3.1

- Added PNG export for the rendered built-in line chart, with a save dialog and default `.png` filename.

## 0.3.0

- Added an opt-in local data server for kdb result panels, exposing current result, selected range, sliced rows, and metadata as CSV, JSON, and NDJSON endpoints.
- Bound the local server to `127.0.0.1`, protected it with a random per-session token, and added stop-server and copy-URL controls in the result panel UI.
- Added the first built-in line chart for eligible numeric/time-oriented columns, backed by extension-side min/max downsampling for large series.
- Updated docs for the local data server and first chart workflow, including current limitations: canvas rendering, no zoom controls, and no full BI-dashboard experience.

## 0.2.9

- Added visual cues for kdb panel column drag/reorder mode, including source header lift/fade and before/after drop indicators.
- Added `kdb-sqltools.results.kdbPanel.arrayDisplayFormat` with `commaSpace` default, `space`, and `raw` display options for nested arrays/lists.
- Updated text copy/export and XLSX output to use the selected array display format while keeping JSON/NDJSON structured.
- Replaced the static docs landing page with a MkDocs Material documentation site, GitHub Pages deployment, and dark/light theme toggle.
- Added GitHub Actions workflows for Pages, Marketplace identity lookup, and Microsoft Entra credential Marketplace publishing.

## 0.2.8

- Moved Auto-fit to the top toolbar as a checkbox and made it update widths from headers plus the currently rendered visible slice only.
- Hid redundant normal success/fetched-row messages while keeping errors visible.
- Added Drag/Select/Sort header interaction modes, with Drag first/default and session-only column reordering.
- Added Markdown copy/export format with `.md` exports.
- Disabled Copy for XLSX while keeping XLSX Export enabled.

## 0.2.7

- Kept focus in the q editor while kdb result panels update after running queries.
- Added kdb table viewport right-click Copy support using the same selected-range copy path as `Ctrl/Cmd+C`.
- Added command-palette feedback commands for bug reports, feature requests, and general feedback with prefilled GitHub issue links.
- Documented feedback links and clarified that VS Code settings cannot host extension feedback buttons.
- Re-verified new kdb result panels continue to open beside existing result panels when available.

## 0.2.6

- Changed new kdb result tabs to open in the same editor group as an existing kdb result panel when one is available, so `Ctrl/Cmd+Shift+Enter` keeps bottom/result layouts intact instead of opening beside the active script editor.
- Kept first-result placement controlled by `kdb-sqltools.results.kdbPanel.initialViewColumn` when no existing kdb result panel is available.

## 0.2.5

- Added replace-vs-new kdb result panel commands and default q keybindings for running selections/scripts without disrupting an existing result layout.
- Added configurable kdb panel default run mode and initial view column, while preserving existing panel editor groups when replacing results.
- Added select-all/deselect-all column visibility controls, clearer zero-visible-column empty states, and visible-slice auto-fit column widths.
- Added per-density persisted sizing presets for compact, standard, and comfortable table densities.
- Added keyboard shortcut documentation and a command to open VS Code keyboard shortcuts for kdb commands.
- Hardened panel lifecycle, stale-result handling, auto-fit edge cases, and release/package artifact checks across three review passes.

## 0.2.4

- Hardened kdb panel virtual scrolling so bottom rows remain reachable on very large result sets, with regression coverage for 1.8M and 10M rows across row heights.
- Replaced the intrusive large-result warning block with a compact toolbar info indicator while keeping hide-once and hide-forever actions.
- Added suppressible large-sort warnings via `kdb-sqltools.results.hideLargeSortWarnings` and a `Sort and Don't Warn Again` action.
- Added human-readable elapsed time display by default with `kdb-sqltools.results.elapsedTimeDisplay` for raw milliseconds.
- Clarified selection labels such as `Selected: 1 cell` instead of `Range 1 x 1`.
- Removed the previously tracked Codex status artifact from the repository.

## 0.2.3

- Added hide-once and hide-forever controls for large-result guardrail messages, backed by `kdb-sqltools.results.hideLargeResultWarnings`.
- Improved array/list cell display to use readable spaced separators like `1 , 2 , 3` while preserving structured JSON/NDJSON exports.
- Added session-only per-column resizing, reset width controls, and auto-widening for visible array-like values.
- Added horizontal virtual-scroll compression to avoid browser maximum scroll-width issues on very wide result sets.
- Replaced separate copy/export format selectors with one shared format selector plus adjacent Copy and Export buttons; XLSX remains export-only.

## 0.2.2

- Fixed large kdb panel tables stopping around ~932k rows in VS Code webviews by compressing physical scroll coordinates below Chromium's max scroll-height limit while preserving real row indexes.
- Updated virtual rendering and search jump scrolling so multi-million-row tables remain reachable without materializing DOM rows.

## 0.2.1

- Hardened q IPC payload validation and receive buffering for malformed/truncated responses and trailing bytes.
- Improved kdb panel correctness for duplicate columns, stale result-version messages, settings allowlist validation, hidden-column state, and async XLSX export races.
- Expanded regression coverage for q IPC edge cases, columnar slices, sorting/filtering, export escaping, XLSX limits, and `Run Selection` behavior.
- Verified package contents exclude local credentials, Codex prompt/plan files, and nested build artifacts.

## 0.2.0

- Made the kdb results panel the default target for `Run q Script` and `Run Selection`, with a direct columnar panel path that avoids SQLTools row-object materialization.
- Optimized q IPC receive buffering to reduce repeated copying while reading large responses.
- Added opt-in performance tracing for q IPC, driver conversion, and kdb panel slice timings via `kdb-sqltools.performance.trace` or `KDB_SQLTOOLS_PERF=1`.
- Made CSV the first/default copy and export format, kept CSV/XLSX/TSV/JSON/NDJSON/HTML export support, and removed the unimplemented Parquet export placeholder.
- Added row-number copy/export, hideable row numbers, and a kdb panel settings menu with global persistence for row-number visibility, copy/export defaults, density, and sizing.
- Added session-scoped hidden columns to the kdb results panel.
- Added visible-column toolbar search for the kdb results panel without bulk cell transfer to the webview.
- Added explicit Select/Sort header mode with Select as the default and extension-side visible-column sorting.
- Added large-result warnings, copy/export confirmations, and XLSX sheet-limit checks for the kdb results panel.
- Changed `Run Selection` to execute selected text exactly, or only the current physical line when no text is selected.

## 0.1.0

- Made the kdb results panel the default result target for q script/selection runs while keeping SQLTools results commands/settings available.
- Expanded kdb panel selection to ranges, rows, columns, and all cells.
- Added copy/export formats for TSV, CSV, JSON, NDJSON, and HTML, plus real XLSX export.
- Added minimal kdb panel cosmetics for cell width, row height, font size, and density.
- Documented SQLTools `.session.sql` behavior and that Parquet export is unavailable in this build.

## 0.0.9

- Reworked optional kdb results panel grid rendering to create DOM cells directly instead of using `innerHTML`/inline `style=` strings, fixing collapsed rows/columns and broken visible-cell selection in VS Code webviews.

## 0.0.8

- Fixed optional kdb results panel cells collapsing/stacking in VS Code webviews by allowing the panel's dynamic virtual-grid positioning styles.

## 0.0.7

- Added optional kdb results panel mode with windowed webview transfer and virtualized rendering while keeping SQLTools results as the default.
- Added range selection and TSV copy support for the optional kdb panel.
- Documented SQLTools User/global versus workspace connection settings behavior.
- Added `kdb+: Copy Example Global Connection Settings` to help users create a persistent User-scope kdb connection.
