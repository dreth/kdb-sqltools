# SQLTools kdb Driver

`kdb-sqltools` is a SQLTools driver extension for connecting VS Code to a kdb+/q process over q IPC.

The driver executes editor text as q, not ANSI SQL. It is intended for qSQL and normal q expressions such as:

```q
select from trade where sym=`AAPL
meta trade
tables `.analytics
```

## Requirements

- VS Code with the `mtxr.sqltools` extension installed ([SQLTools website](https://vscode-sqltools.mteixeira.dev/) / [GitHub](https://github.com/mtxr/vscode-sqltools)).
- A kdb+/q process listening on a TCP port, for example:

```sh
q -p 5000
```

## Connection Settings

Example SQLTools connection:

```json
{
  "name": "local kdb",
  "driver": "KDB",
  "server": "localhost",
  "port": 5000,
  "username": "",
  "password": "",
  "database": ".",
  "connectionTimeout": 30
}
```

The `database` field is used as a q namespace for the object explorer. Use `.` for the root namespace or values such as `.analytics`. Queries are sent exactly as written to the remote q process.

### Persisting Connections

SQLTools stores connections in the VS Code setting `sqltools.connections`. That setting can exist at User/global scope, Workspace scope, or Workspace Folder scope. User-scope connections follow you across VS Code restarts and workspaces. Workspace-scope connections only appear when that workspace is open, so a connection can look missing after switching folders or opening VS Code without the same workspace.

If you create a connection through SQLTools while a workspace is open, check whether it was saved to the workspace settings. To make a kdb connection global, put it in User settings JSON:

```json
{
  "sqltools.connections": [
    {
      "name": "local kdb",
      "driver": "KDB",
      "server": "localhost",
      "port": 5000,
      "username": "",
      "password": "",
      "database": ".",
      "connectionTimeout": 30
    }
  ]
}
```

The `kdb+: Copy Example Global Connection Settings` command copies this User-settings fragment and can open settings for you. If you already have SQLTools connections, merge the example object into the existing `sqltools.connections` array instead of replacing the array.

## Features

- TCP q IPC authentication handshake with optional username/password.
- Synchronous text query execution.
- Result grids for q tables, keyed tables, dictionaries, vectors, lists, and scalars. Nested q values inside cells are displayed as compact strings, and unsafe-width q longs are displayed as exact decimal strings.
- Cancellable kdb results panel runs from the panel toolbar or VS Code progress notification.
- Opt-in local data server for the current kdb results panel, bound to `127.0.0.1` with tokenized URLs for metadata, CSV, JSON, NDJSON, slices, and selection.
- Built-in uPlot-powered charting from the current kdb results panel with extension-side downsampling, optional categorical group-by for line/scatter/step/bar charts, cursor tooltips, drag zoom, debounced and explicit zoom refinement, persisted chart selections by column signature, reset zoom, splitter resizing, legend toggling, and PNG export.
- Object explorer groups for tables, root q views, functions, and table columns. Column metadata preserves q `meta` type, foreign-key, and attribute fields for SQLTools describe/explorer views.
- Table preview and count support through SQLTools, using q `sublist` for limit/offset previews.
- Definition query generation for tables, views, and functions.
- Insert snippet generation using q `insert` syntax compatible with SQLTools' insert formatter.
- Minimal q keyword completions only; q language extensions should handle language-level autocomplete.
- SSH tunneling through SQLTools common connection settings.

## kdb Results Panel

The kdb results panel is the default target for `kdb+: Run q Script` and `kdb+: Run Selection`. It runs through this extension's direct driver path and avoids SQLTools `*.session.sql` editor documents. `Run Selection` sends the selected text exactly; with no selection, it sends the current physical line. A blank current line uses the normal no-code warning. For multi-line, lambda, or blank-line-bounded block execution, select the text explicitly or use the explicit `Run Selection or q Block` commands.

Default kdb-panel runs open a new result tab unless you set `"kdb-sqltools.results.kdbPanel.defaultRunMode": "replace"`. Explicit commands are also available:

- `kdb+: Run Selection in kdb Panel (Replace)` reuses the current or first existing kdb result tab.
- `kdb+: Run Selection in New kdb Panel` opens an independent result tab.
- `kdb+: Run Selection and Chart` reuses the current or first existing kdb result tab, runs the selected text or current physical line, and opens/renders the chart panel.
- `kdb+: Run Selection or q Block in kdb Panel (Replace)` reuses the current or first existing kdb result tab and falls back to the current q block when there is no selection.
- `kdb+: Run Selection or q Block and Chart` reuses the current or first existing kdb result tab, falls back to the current q block when there is no selection, and opens/renders the chart panel.
- `kdb+: Run q Script in kdb Panel (Replace)` reuses an existing kdb result tab.
- `kdb+: Run q Script in New kdb Panel` opens an independent result tab.

Default keybindings in q files are `Ctrl+Enter` / `Cmd+Enter` for selection replace, `Ctrl+Shift+Enter` / `Cmd+Shift+Enter` for selection in a new result tab, `Ctrl+Alt+Enter` / `Cmd+Alt+Enter` for whole-script replace, and `Ctrl+Alt+C` / `Cmd+Alt+C` for `Run Selection and Chart`. Change them in VS Code's Keyboard Shortcuts UI or `keybindings.json`; extension settings cannot define arbitrary VS Code keybindings. The `kdb+: Open kdb Keyboard Shortcuts` command opens the Keyboard Shortcuts UI.

Running kdb-panel commands keeps focus in the q editor while the result tab updates.

While a run is loading, the panel shows `Cancel` next to the spinner and the VS Code progress notification is cancellable. Canceling stops the extension from waiting for that run, tears down the active q IPC connection, and leaves a canceled state in the panel. Server-side interruption is best-effort: q or gateway work that already started may not stop immediately.

When replacing results, the extension reveals the existing kdb result tab in its current editor group instead of forcing `ViewColumn.Beside`. New kdb result tabs open beside existing kdb result tabs when one is already present. VS Code does not provide an extension API to create a bottom split automatically, so the first new kdb result tab uses `"kdb-sqltools.results.kdbPanel.initialViewColumn"` (`active`, `beside`, `one`, `two`, or `three`).

To use SQLTools' own results target instead, set:

```json
"kdb-sqltools.results.target": "sqltools"
```

SQLTools target commands remain available: `kdb+: Run q Script in SQLTools Results` and `kdb+: Run Selection in SQLTools Results`. SQLTools may open `.session.sql` editors there; that is SQLTools core behavior, not this driver's panel path.

The kdb panel virtualizes rows and columns and transfers only the visible cell window from the extension to the webview. Panel results use a direct columnar path that avoids SQLTools row-object materialization, and the q IPC receive path buffers chunks incrementally to reduce copying for large responses. The q IPC result is still fully materialized in extension memory before display, so use q-side limits for truly massive query results. Very large results show a non-blocking warning in the panel.

Selection supports individual ranges, whole rows, whole columns, and all cells. With no selection, copy/export actions use all cells.

Columns can be hidden from the panel settings menu for the current panel session. Select all and Deselect all controls are available; deselecting all data columns leaves the row-number column and a clear empty state. Hidden columns stay hidden for later results in that panel only when the full column list matches, and reset restores all columns. Hidden-column choices are not saved globally.

The Settings -> Preferences Auto-fit checkbox is enabled by default and sizes visible columns from headers plus the currently rendered cells as you scroll. Column widths can still be dragged per session, and Reset column widths clears manual overrides.

Header mode defaults to Drag. Drag column headers to reorder visible columns for the current panel session; copy, export, search, and sort use that visible order. Change the Settings menu mode to Select for whole-column selection or Sort to sort visible columns in the extension; repeated sort clicks cycle ascending, descending, and original order. Sorting uses the panel's visible cell text, warns before sorting very large row counts, and resets on the third click.

Settings menu search runs in the extension against visible columns only. It returns capped row-match metadata to the webview instead of transferring all result cells, and the status marks capped or partial scans.

The top toolbar is a single compact line: `Output`, copy/export controls, a top-level `Chart` button, `Settings`, and the short loading-only `Cancel` button. `Settings` contains collapsible sections for view controls, search, hidden columns, output defaults, and `Data server` controls. The data server can start a tokenized local server for the current panel result and copy current-result URLs; its base URL is shown only in the Settings data-server section. `Chart` opens a uPlot-powered chart panel with compact chart type, x, optional group-by, and y controls for line, scatter, step, bar, and box charts. The local server never starts automatically, binds only to `127.0.0.1`, and falls forward from port `7742` if needed. The built-in chart supports one numeric/temporal x column and one or more numeric y columns from visible columns, with extension-side min/max downsampling before data reaches the webview, optional categorical group-by for line/scatter/step/bar charts, auto-thinned readable x-axis labels for dense timestamp or numeric axes, cursor tooltips, drag zoom, debounced zoom auto-refinement when visible sampled points fall below the configured minimum, explicit zoom refinement, reset zoom, splitter resizing, legend toggling, persisted chart selections for matching column signatures, and PNG export after render. Changing controls leaves the old rendered chart visible until `Render` is pressed. Box charts summarize numeric y columns into per-x/bucket min/quartile/median/max boxes.

Normal successful result messages stay hidden because the top summary already shows row count and elapsed time; errors remain visible in the message area.

Copy formats: CSV, TSV, JSON, NDJSON, HTML, Markdown. Right-click Copy in the table viewport uses the same selected range and copy settings as `Ctrl+C` / `Cmd+C`. Export formats: CSV, XLSX, TSV, JSON, NDJSON, HTML, Markdown. XLSX export writes a real `.xlsx` workbook and rejects output beyond Excel's sheet limits; XLSX remains export-only and cannot be copied. Large copy/export actions prompt before materializing output; the confirmation cell threshold is configurable from Settings -> Preferences or `kdb-sqltools.results.copyExportConfirmCellThreshold`. The row-number/header copy and export options are enabled by default and persist globally from the panel settings menu.

kdb panel settings:

```json
{
  "kdb-sqltools.results.cellWidth": 160,
  "kdb-sqltools.results.rowHeight": 28,
  "kdb-sqltools.results.fontSize": 0,
  "kdb-sqltools.results.density": "standard",
  "kdb-sqltools.results.kdbPanel.defaultRunMode": "new",
  "kdb-sqltools.results.kdbPanel.initialViewColumn": "active",
  "kdb-sqltools.results.kdbPanel.arrayDisplayFormat": "commaSpace",
  "kdb-sqltools.results.compact.cellWidth": 140,
  "kdb-sqltools.results.compact.rowHeight": 24,
  "kdb-sqltools.results.compact.fontSize": 0,
  "kdb-sqltools.results.standard.cellWidth": 160,
  "kdb-sqltools.results.standard.rowHeight": 28,
  "kdb-sqltools.results.standard.fontSize": 0,
  "kdb-sqltools.results.comfortable.cellWidth": 180,
  "kdb-sqltools.results.comfortable.rowHeight": 32,
  "kdb-sqltools.results.comfortable.fontSize": 0,
  "kdb-sqltools.results.showRowIndex": true,
  "kdb-sqltools.results.includeHeaders": true,
  "kdb-sqltools.results.includeRowIndex": true,
  "kdb-sqltools.results.hideLargeResultWarnings": false,
  "kdb-sqltools.results.hideLargeSortWarnings": false,
  "kdb-sqltools.results.copyExportConfirmCellThreshold": 1000000,
  "kdb-sqltools.results.localDataServerFullExportCellLimit": 1000000,
  "kdb-sqltools.results.elapsedTimeDisplay": "auto"
}
```

`fontSize: 0` uses the VS Code default. Density can be `compact`, `standard`, or `comfortable`; each density has its own saved `cellWidth`, `rowHeight`, and `fontSize`. The legacy top-level size settings remain as fallbacks for existing user configuration. `elapsedTimeDisplay` can be `auto` or `milliseconds`. `arrayDisplayFormat` can be `commaSpace` (`1, 2, 3`), `space` (`1 2 3`), or `raw` (`[1 2 3]` where q-ish bracketed display is supported). `showRowIndex` controls the visible left row-number column; `includeHeaders` and `includeRowIndex` control default copy/export output. Text copy/export formats use display text; JSON and NDJSON keep structured values. Large-result and large-sort warnings can be suppressed from the panel or these settings. `copyExportConfirmCellThreshold` controls when panel copy/export asks for confirmation; `localDataServerFullExportCellLimit` controls the local data server hard limit for full `current.*` exports.

## Performance Trace

Opt-in performance tracing logs query timing and memory snapshots to the VS Code extension host console with the `[kdb-sqltools:perf]` prefix. It helps diagnose large-query bottlenecks across IPC receive, result conversion, and panel slicing.

Enable it with either:

```json
"kdb-sqltools.performance.trace": true
```

or by launching VS Code with `KDB_SQLTOOLS_PERF=1`.

## Feedback

VS Code settings cannot host extension buttons, so feedback actions are available as Command Palette commands:

- `kdb+: Report Bug`
- `kdb+: Request Feature`
- `kdb+: Give Feedback`

GitHub links:

- [Bug report][bug-report]
- [Feature request][feature-request]
- [General feedback][general-feedback]

[bug-report]: https://github.com/dreth/kdb-sqltools/issues/new?title=Bug%3A%20&labels=bug&body=%23%23%20What%20happened%0A%0A%0A%23%23%20Expected%20behavior%0A%0A%0A%23%23%20Steps%20to%20reproduce%0A1.%20%0A2.%20%0A3.%20%0A%0A%23%23%20Environment%0A-%20VS%20Code%3A%0A-%20kdb-sqltools%3A%0A-%20OS%3A%0A-%20kdb%2B%2Fq%3A
[feature-request]: https://github.com/dreth/kdb-sqltools/issues/new?title=Feature%20request%3A%20&labels=enhancement&body=%23%23%20What%20would%20you%20like%20to%20do%3F%0A%0A%0A%23%23%20Why%20is%20this%20useful%3F%0A%0A%0A%23%23%20Current%20workaround%0A
[general-feedback]: https://github.com/dreth/kdb-sqltools/issues/new?title=Feedback%3A%20&labels=feedback&body=%23%23%20Feedback%0A%0A%0A%23%23%20Context%0A

## Limitations

- TLS is not implemented by this driver, so no TLS option is exposed in the connection UI.
- The driver does not translate SQL to q. Write q/qSQL directly.
- Arbitrary editor queries are sent exactly as written. The driver does not add hidden limits; the kdb panel reduces webview transfer and DOM work, but it does not stream q execution. Canceling a kdb-panel run closes the client IPC connection and stops VS Code waiting, but already-running server-side work may continue depending on q/gateway behavior. The SQLTools target renders however many rows SQLTools receives.
- SQLTools' "execute current query" command uses SQL-style semicolon/`GO` statement parsing before the driver is called. For q expressions that contain semicolons inside lambdas, projections, or multi-statement expressions, select the intended q text and run `kdb+: Run Selection` so it is sent as one q expression.
- kdb has namespaces rather than SQL catalogs and schemas; SQLTools `database`/`schema` fields are mapped to the selected q namespace.
- Root q views are listed with protected `views[]`; non-root view listing depends on what the target process returns for protected `system "b <namespace>"`.
- The default automated E2E suite uses a mock q IPC server so it can run without licensed kdb+/q tooling. Use `npm run test:live-kdb` for an opt-in live q process smoke test.

## Development

Install dependencies:

```sh
npm install
```

Compile:

```sh
npm run compile
```

Run unit tests:

```sh
npm run test:unit
```

Run the VS Code E2E suite:

```sh
npm run test:e2e
```

Run compile, unit tests, and E2E tests:

```sh
npm test
```

Run the opt-in live kdb+/q integration test when a local `q` binary is available:

```sh
KDB_Q_BIN=/path/to/q npm run test:live-kdb
```

The live test starts a real local `q -p <free-port>` process with `test/live/fixture.q`, then exercises the driver over real q IPC for handshake, query execution, table/view/function listing, column metadata, scalar results, definitions, and preview queries. It skips cleanly if no `q` binary is found unless `KDB_SQLTOOLS_LIVE_REQUIRED=1` is set.

Run everything, including live q, and fail if q is unavailable:

```sh
KDB_SQLTOOLS_LIVE_REQUIRED=1 npm run test:all
```

Start the compiler in watch mode while launching the extension host from VS Code:

```sh
npm run watch
```

This repository is not published to the VS Code Marketplace by the build scripts.

### E2E Test Pipeline

`npm run test:e2e` uses `@vscode/test-electron` to download a local VS Code build under `.vscode-test`, installs the real `mtxr.sqltools` Marketplace extension into an isolated test extensions directory, and launches a VS Code extension host for this extension.

Inside that extension host the test suite:

- activates this extension and verifies the SQLTools registration path with the real SQLTools extension;
- starts a mock q IPC server in the test process;
- opens the compiled `KdbDriver` against that TCP server;
- verifies `testConnection()` sends `1+1`;
- verifies query result conversion for a small table;
- verifies table listing and column metadata through the driver's object explorer methods.

On Linux without a display, the runner uses `xvfb-run` when available with `xauth`; otherwise it starts `Xvfb` directly. `npm run test:e2e` also runs `npm run prepare:e2e-linux-libs`, which uses `apt-get download` plus `dpkg-deb -x` without sudo to unpack the small set of VS Code desktop libraries this container is missing into `.vscode-test/apt-libs/root`. CI images should still install normal Electron/GTK runtime packages when possible; the bootstrap is a no-root fallback for minimal containers.

Useful E2E environment variables:

- `KDB_SQLTOOLS_E2E_VSCODE_VERSION=1.124.2` pins the downloaded VS Code version instead of `stable`.
- `KDB_SQLTOOLS_E2E_FORCE_SQLTOOLS_INSTALL=1` reinstalls `mtxr.sqltools`.
- `KDB_SQLTOOLS_E2E_SKIP_SQLTOOLS_INSTALL=1` skips the install step and uses whatever is already in `.vscode-test/e2e/extensions`.
- `KDB_SQLTOOLS_E2E_ALLOW_SQLTOOLS_INSTALL_FAILURE=1` allows a driver-only VS Code host fallback when Marketplace access is unavailable; the SQLTools activation test is skipped in that mode.
- `KDB_SQLTOOLS_E2E_RUNTIME_LIB_DIR=/path/to/libs` prepends a custom Linux runtime library directory for minimal containers.
- `KDB_SQLTOOLS_E2E_SKIP_LINUX_LIBS=1` skips the no-root `apt-get download`/`dpkg-deb` runtime-library bootstrap.
