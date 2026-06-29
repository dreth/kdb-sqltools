# Troubleshooting

## SQLTools is required

`kdb-sqltools` depends on SQLTools. Install SQLTools first:

- <https://marketplace.visualstudio.com/items?itemName=mtxr.sqltools>
- <https://vscode-sqltools.mteixeira.dev/>
- <https://github.com/mtxr/vscode-sqltools>

If SQLTools is missing, the kdb driver cannot register.

## Connection does not appear

Check where SQLTools saved `sqltools.connections`.

User settings are available across workspaces. Workspace settings are available only when that workspace is open.

Run `kdb+: Copy Example Global Connection Settings` to copy a User-settings connection example.

## Cannot connect to local q

Confirm q is listening:

```sh
q -p 5000
```

Then confirm the connection uses:

```json
{
  "driver": "KDB",
  "server": "localhost",
  "port": 5000
}
```

If your q process requires IPC credentials, set `username` and `password`.

## SQLTools session filenames

SQLTools' own result target may open `*.session.sql` editor documents. That filename is owned by SQLTools, not this driver.

Use the kdb panel target to avoid the SQLTools session-file workflow:

```json
"kdb-sqltools.results.target": "kdbPanel"
```

## q expressions with semicolons

SQLTools' execute-current-query flow uses SQL-style statement parsing before the driver is called. For q expressions that contain semicolons inside lambdas, projections, or multi-statement expressions, select the intended q text and run `kdb+: Run Selection` so it is sent as one q expression.

## Huge results and exports

The kdb panel virtualizes display, but the q IPC result is fully materialized in extension memory before display. Use q-side limits for very large queries.

Large copy/export actions prompt before output is materialized. XLSX export also enforces Excel sheet limits.

If a q run is taking too long, click `Cancel query` in the kdb results panel or cancel the VS Code progress notification. This closes the client IPC connection and stops VS Code waiting, but already-running q or gateway work may not stop immediately.

## Parquet export

Parquet export is not implemented yet.

## Live q tests

The repository's automated end-to-end tests use a mock q IPC server so they can run without licensed kdb+/q tooling. Maintainers can run an opt-in live q smoke test against a real local q process:

```sh
q -p 5000
npm run test:live-kdb
```

## Other limitations

- TLS is not implemented by this driver.
- The driver sends q text as written; it does not translate ANSI SQL.
- kdb has namespaces rather than SQL catalogs and schemas. SQLTools `database` and `schema` fields map to q namespaces.
- Root q views are listed with protected `views[]`; non-root view listing depends on what the target process returns for protected `system "b <namespace>"`.

## Public docs show raw Markdown

If the public docs render as raw Markdown with no left sidebar, GitHub Pages is serving the `docs/` branch source instead of the MkDocs build. In the repository, set Settings -> Pages -> Build and deployment -> Source to `GitHub Actions`.
