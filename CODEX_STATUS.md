# CODEX Status

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
- Added Linux headless handling for E2E runs: `xvfb-run` when usable, direct `Xvfb` fallback when `xauth` is missing, and an optional runtime library path hook for minimal containers.

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
- Linux E2E runs require VS Code desktop runtime libraries. The runner handles the display server, but CI images still need GTK/Electron shared libraries installed or supplied through `KDB_SQLTOOLS_E2E_RUNTIME_LIB_DIR`.

## Remaining Risks

- Metadata expressions using `system "b "` and `system "f "` depend on standard q system commands being enabled on the target process.
- Very large 64-bit integers and nanosecond temporal values are converted for display and may lose precision beyond JavaScript number limits.
- npm audit reports inherited dependency vulnerabilities from the SQLTools/template dependency tree; broad audit fixes were not applied to avoid unrelated dependency churn.
- The SQLTools Marketplace install is network-dependent. By default E2E fails if `mtxr.sqltools` cannot be installed; `KDB_SQLTOOLS_E2E_ALLOW_SQLTOOLS_INSTALL_FAILURE=1` runs the driver-only host fallback and skips the SQLTools activation assertion.
