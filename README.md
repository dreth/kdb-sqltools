# SQLTools kdb Driver

`kdb-sqltools` is a SQLTools driver extension for connecting VS Code to a kdb+/q process over q IPC.

The driver executes editor text as q, not ANSI SQL. It is intended for qSQL and normal q expressions such as:

```q
select from trade where sym=`AAPL
meta trade
tables `.analytics
```

## Requirements

- VS Code with the `mtxr.sqltools` extension installed.
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

## Features

- TCP q IPC authentication handshake with optional username/password.
- Synchronous text query execution.
- Result grids for q tables, keyed tables, dictionaries, vectors, lists, and scalars. Nested q values inside cells are displayed as compact strings, and unsafe-width q longs are displayed as exact decimal strings.
- Object explorer groups for tables, views, functions, and table columns.
- Table preview and count support through SQLTools, using q `sublist` for limit/offset previews.
- Definition query generation for tables, views, and functions.
- Insert snippet generation using q `insert` syntax compatible with SQLTools' insert formatter.
- Minimal q keyword completions only; q language extensions should handle language-level autocomplete.
- SSH tunneling through SQLTools common connection settings.

## Limitations

- TLS is not implemented by this driver, so no TLS option is exposed in the connection UI.
- The driver does not translate SQL to q. Write q/qSQL directly.
- Arbitrary editor queries are sent exactly as written. The driver does not add hidden limits; SQLTools will render however many rows the q expression returns.
- SQLTools' "execute current query" command uses SQL-style semicolon/`GO` statement parsing before the driver is called. For q expressions that contain semicolons inside lambdas, projections, or multi-statement blocks, select the intended q text and run the normal execute command so it is sent as one q expression.
- kdb has namespaces rather than SQL catalogs and schemas; SQLTools `database`/`schema` fields are mapped to the selected q namespace.
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

The live test starts a real local `q -p <free-port>` process with `test/live/fixture.q`, then exercises the driver over real q IPC for handshake, query execution, table listing, column metadata, scalar results, and preview queries. It skips cleanly if no `q` binary is found unless `KDB_SQLTOOLS_LIVE_REQUIRED=1` is set.

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
- `KDB_SQLTOOLS_E2E_ALLOW_SQLTOOLS_INSTALL_FAILURE=1` allows a driver-only VS Code host fallback when Marketplace access is blocked; the SQLTools activation test is skipped in that mode.
- `KDB_SQLTOOLS_E2E_RUNTIME_LIB_DIR=/path/to/libs` prepends a custom Linux runtime library directory for minimal containers.
- `KDB_SQLTOOLS_E2E_SKIP_LINUX_LIBS=1` skips the no-root `apt-get download`/`dpkg-deb` runtime-library bootstrap.
