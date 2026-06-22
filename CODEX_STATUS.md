# CODEX Status

## 2026-06-22 Pass 2 kdb Panel Windowing

Changed:

- Refactored the kdb results panel protocol so the webview receives result metadata only: columns, row count, query, connection name, elapsed time, messages, error state, and a version.
- Kept the full `KdbPanelResult.rows` array extension-side and added viewport slice requests from the webview for visible row/column windows plus overscan.
- Extension responses now send only the requested visible cell window as display strings; the full row array is not posted to the webview.
- Preserved virtualized DOM rendering for visible rows/columns only.
- Kept range selection independent of the loaded viewport slice, including larger ranges selected by shift-clicking after scrolling.
- Added selected range dimensions in the toolbar.
- Added `Copy TSV + Headers` alongside the existing headerless TSV copy; both copy paths use extension-side `rowsToTsv`.
- Added pure helper coverage for TSV headers and visible cell window serialization.
- Documented optional kdb panel mode and the remaining massive-result caveat in `README.md`.
- No new runtime dependencies were added.
- Package version remains `0.0.6`; final `0.0.7` packaging remains for Pass 3.

Verification:

- `npm run compile` passed.
- `npm run test:unit` passed.
- `npm test` passed.
- `git diff --check` passed.

Remaining limitations:

- q IPC query execution still materializes the full q result in the extension process before panel display; this pass only windows webview transfer and DOM rendering.
- The panel still uses fixed column widths.
- No client-side find/filter was added, avoiding repeated large-result scans in the webview.

Next pass recommendation:

- Pass 3 should address connection persistence UX/docs, bump/package `0.0.7`, and run the final live/package verification.

## 2026-06-22 Pass 1 kdb Panel

Changed:

- Added `kdb-sqltools.results.target` with `sqltools` default and optional `kdbPanel`.
- Kept existing `kdb-sqltools.runFile` and `kdb-sqltools.runSelectionOrBlock` behavior on the default `sqltools` target.
- Added explicit SQLTools and kdb panel commands:
  - `kdb-sqltools.runFileInSqltools`
  - `kdb-sqltools.runSelectionOrBlockInSqltools`
  - `kdb-sqltools.runFileInKdbPanel`
  - `kdb-sqltools.runSelectionOrBlockInKdbPanel`
- Added a direct kdb panel execution path using configured `sqltools.connections` for this driver and the existing `KdbDriver.query()` IPC path.
- Added a lightweight webview result panel with sticky header, fixed-size row/column virtualization, click/drag range selection, selected range highlighting, and TSV copy through the button or `Ctrl/Cmd+C` while the panel has focus.
- Added pure helpers for range normalization, selection checks, TSV conversion, and visible-window math.
- Added unit coverage for the new pure helpers.
- No new runtime dependencies were added.
- Package version remains `0.0.6`; this pass was not packaged as final `0.0.7`.

Verification:

- `npm run compile` passed.
- `npm run test:unit` passed.
- `npm test` passed.
- `git diff --check` passed.

Remaining limitations:

- The kdb panel path reads saved SQLTools kdb connection settings from `sqltools.connections`; it does not reuse SQLTools' active connection object because no public SQLTools command/API in this repo exposes a row-returning active-connection query path without opening SQLTools results.
- The panel virtualizes DOM rows and columns, but query execution still materializes the q result in the extension process before posting it to the webview.
- Column widths are fixed in Pass 1.
- Copy supports selected data cells only; headers are not included yet.
- Connection persistence UX confusion is not addressed in Pass 1.

Blockers:

- None for Pass 1.

Next pass recommendation:

- Pass 2 should harden large-result behavior around payload transfer/materialization, add row/column counts and optional copy-with-headers, and consider column resizing without adding heavy dependencies.

## 2026-06-17 Final SQLTools Compatibility Pass

Changed:

- Fixed SQLTools table preview/count query generation for non-root q namespaces when SQLTools calls `showRecords()` with namespace metadata on the table item instead of top-level query params.
- Added unit and live q regressions covering non-root table preview/count through SQLTools' base-driver path.

Intentionally out of scope:

- No q autocomplete/snippet expansion was added.
- Arbitrary user queries are still sent exactly as written and are not rewritten or limited by the driver.
- No additional SQLTools feature areas were added beyond the final preview/count blocker fix.

Verification:

- `npm test` passed.
- `KDB_SQLTOOLS_LIVE_REQUIRED=1 npm run test:live-kdb` passed using `/opt/data/home/.kx/bin/q`.
- `npm pack --dry-run --ignore-scripts` passed.
- `git diff --check` passed.

## 2026-06-17 Live Metadata Edge Cases Pass

Changed:

- Fixed protected root view listing by calling q `views[]` with the correct null argument form under `@[...]`.
- Reworked generated column metadata to build a stable q table projection, preserving original `meta` `c`, `t`, `f`, and `a` fields for SQLTools describe/explorer details.
- Expanded the live q fixture and assertions for root views, functions, empty table columns, keyed-table previews, list/mixed column metadata, q column attributes, definitions, and missing namespace tables/views/functions.
- Added unit guards for protected view query generation, stable column metadata query shape, and uppercase list type display.

Intentionally out of scope:

- No q language autocomplete/snippet expansion was added.
- Non-root q view discovery remains limited to what the target q process returns for protected `system "b <namespace>"`.
- Arbitrary user queries are still sent exactly as written and are not rewritten or limited by the driver.

Verification:

- `npm test` passed.
- `KDB_SQLTOOLS_LIVE_REQUIRED=1 npm run test:live-kdb` passed using `/opt/data/home/.kx/bin/q`.
- `npm pack --dry-run --ignore-scripts` passed.
- `git diff --check` passed.

## 2026-06-17 Result Conversion Safety Pass

Changed:

- Normalized nested q values inside SQLTools grid cells to primitive display strings so list, dictionary, nested table, and object cells do not reach SQLTools as arrays or objects.
- Preserved exact display for q long atoms and vectors outside JavaScript's safe integer range by returning decimal strings instead of imprecise rounded numbers.
- Added unit coverage for keyed tables, empty tables, nested/list columns, char vectors, null symbols, and unsafe long display using q IPC payload fixtures.
- Expanded the live q fixture and assertions for keyed tables, empty tables, nested/list cells, chars/strings, symbol nulls, temporal values, and large long display.
- Documented the grid display behavior for nested q cells and unsafe-width longs.

Intentionally out of scope:

- No arbitrary user query limiting or rewriting was added.
- No q autocomplete/snippet expansion was added.

Verification:

- `npm run test:unit` passed.
- `npm test` passed.
- `KDB_SQLTOOLS_LIVE_REQUIRED=1 npm run test:live-kdb` passed using `/opt/data/home/.kx/bin/q`.
- `npm pack --dry-run --ignore-scripts` passed.
- `git diff --check` passed.

## 2026-06-17 Metadata Robustness Pass

Changed:

- Protected generated q metadata calls for table, view, and function listing with `@[...]`, so missing q namespaces and rejected `system "b"`/`system "f"` calls return empty metadata rows instead of q errors.
- Added driver-side fallback for optional Views and Functions explorer groups: if those metadata queries still fail, SQLTools gets an empty group instead of an explorer error. Table listing failures still propagate because a broken table listing should remain visible.
- Added unit coverage for protected metadata query generation, optional group fallback behavior, and the retained table-listing error path.
- Updated the E2E mock IPC server to recognize protected metadata query forms.
- Added a live q assertion that listing tables in a missing namespace returns an empty SQLTools result, not an error.
- Documented SQLTools' current-query semicolon/`GO` parsing limitation for q expressions that contain semicolons internally.

Intentionally out of scope:

- No q autocomplete/snippet expansion was added.
- The driver still does not rewrite arbitrary q editor text or bypass SQLTools' current-query parser; users should select complex q blocks explicitly when needed.
- Arbitrary query results remain unbounded by the driver.
- TLS remains unsupported.

Verification:

- `npm test` passed.
- `KDB_SQLTOOLS_LIVE_REQUIRED=1 npm run test:live-kdb` passed using `/opt/data/home/.kx/bin/q`.
- `npm pack --dry-run --ignore-scripts` passed.
- `git diff --check` passed.

## 2026-06-17 SQLTools Compatibility Pass

Changed:

- Made generated q insert snippets survive SQLTools' `formatInsertQuery` behavior, which strips the final two characters and appends `);`.
- Added table/view/function definition text generation for SQLTools' definition command: tables/views return `meta <symbol>`, functions return `.Q.s1 value <symbol>`.
- Normalized `describeTable` rows through the same q type-name conversion used by object explorer columns, including uppercase list type codes such as `J`.
- Changed table preview queries to use `(offset;limit) sublist value <table>` and kept SQLTools' separate count query path.
- Avoided an extra row-copy pass when converting already-normalized q table and keyed-table results for the SQLTools grid.
- Exposed SSH tunnel settings in the connection schema because the driver already supports `createSshTunnel`.

Intentionally out of scope:

- No TLS fields are exposed; q IPC/TLS is not implemented or tested in this driver.
- Arbitrary user queries are not limited or rewritten. Large result sets remain the user's responsibility and SQLTools will render the rows returned by q.
- No new q language autocomplete/snippet features were added beyond keeping the existing minimal static keywords functional.

Verification:

- `npm test` passed.
- `KDB_SQLTOOLS_LIVE_REQUIRED=1 npm run test:live-kdb` passed using `/opt/data/home/.kx/bin/q`.
- `npm pack --dry-run --ignore-scripts` passed.
- `git diff --check` passed.

## Implementation

- Converted the SQLTools template into `kdb-sqltools` with kdb+/q package metadata, driver alias registration, and host/port/auth/namespace connection assistant fields.
- Implemented a TCP q IPC client in TypeScript for authentication handshake, synchronous text queries, response framing, compressed response decoding, and q error responses.
- Added q IPC deserialization for common atoms, vectors, generic lists, dictionaries, tables, keyed tables, temporal values, and functions as display placeholders.
- Added SQLTools result conversion for scalars, vectors, dictionaries, tables, and keyed tables.
- Added q metadata query builders for tables, views, functions, columns via `meta`, record preview, record counts, and search support.
- Added q insert snippet generation and basic q keyword completions.
- Replaced the template README with install, development, connection, feature, and limitation notes.
- Added a VS Code E2E test pipeline using `@vscode/test-electron`. It downloads a local VS Code build, installs the real `mtxr.sqltools` Marketplace extension into an isolated extensions directory, launches the extension host headlessly, and exercises this extension plus the compiled driver.
- Added a mock q IPC TCP server for E2E tests. It authenticates the q IPC handshake, receives sync text queries, and returns valid q IPC responses for `1+1`, table metadata, column metadata, counts, functions, views, and a small table result.
- Added Linux headless handling for E2E runs: `xvfb-run` when usable, direct `Xvfb` fallback when `xauth` is missing, an optional runtime library path hook, and a no-root `apt-get download`/`dpkg-deb` bootstrap for missing VS Code GTK runtime libraries in minimal containers.

## Checks

- `npm install --save-dev @vscode/test-electron@3.0.0 mocha@11.7.6` completed and refreshed `package-lock.json`.
- `npm run compile` passed.
- `npm run test:unit` passed.
- `npm run test:e2e` passed with VS Code 1.124.2 and SQLTools 0.28.5 installed in `.vscode-test/e2e/extensions`.

## Limitations

- The automated E2E suite uses a mock q IPC server, not a real kdb+/q binary. It verifies the VS Code extension host, SQLTools activation/register path, actual driver TCP IPC path, and result conversion, but it does not validate q runtime semantics against a real q process.
- The driver executes q text directly; it does not translate ANSI SQL to q.
- TLS is not implemented or exposed.
- q IPC support is pragmatic rather than exhaustive. It covers common query and metadata results, including compressed responses, but exotic q runtime objects may be displayed as placeholders.
- SQLTools database/schema concepts are mapped to a q namespace such as `.` or `.analytics`.
- Linux E2E runs require VS Code desktop runtime libraries. The runner handles the display server and can bootstrap the missing GTK-related libraries in this no-root container, but normal CI images should still install Electron/GTK runtime packages directly when possible.

## Remaining Risks

- Metadata expressions using `system "b "` and `system "f "` depend on standard q system commands being enabled on the target process.
- Very large 64-bit integers are displayed as exact decimal strings when needed; nanosecond temporal values are converted for display and may lose sub-millisecond precision.
- npm audit reports inherited dependency vulnerabilities from the SQLTools/template dependency tree; broad audit fixes were not applied to avoid unrelated dependency churn.
- The SQLTools Marketplace install is network-dependent. By default E2E fails if `mtxr.sqltools` cannot be installed; `KDB_SQLTOOLS_E2E_ALLOW_SQLTOOLS_INSTALL_FAILURE=1` runs the driver-only host fallback and skips the SQLTools activation assertion.
