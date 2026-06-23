# Change Log

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
