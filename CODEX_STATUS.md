# CODEX Status

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
- Very large 64-bit integers and nanosecond temporal values are converted for display and may lose precision beyond JavaScript number limits.
- npm audit reports inherited dependency vulnerabilities from the SQLTools/template dependency tree; broad audit fixes were not applied to avoid unrelated dependency churn.
- The SQLTools Marketplace install is network-dependent. By default E2E fails if `mtxr.sqltools` cannot be installed; `KDB_SQLTOOLS_E2E_ALLOW_SQLTOOLS_INSTALL_FAILURE=1` runs the driver-only host fallback and skips the SQLTools activation assertion.
