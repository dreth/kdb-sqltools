# Installation

## Install SQLTools

Install SQLTools first. This extension depends on it and activates it at runtime.

- SQLTools Marketplace: <https://marketplace.visualstudio.com/items?itemName=mtxr.sqltools>
- SQLTools GitHub repository: <https://github.com/mtxr/vscode-sqltools>
- SQLTools documentation: <https://vscode-sqltools.mteixeira.dev/>

If SQLTools is missing, `kdb-sqltools` cannot register the `KDB` driver.

## Install kdb-sqltools

Install the SQLTools kdb Driver extension in VS Code. After installation, reload VS Code if the SQLTools connection assistant does not list the `KDB` driver immediately.

- kdb-sqltools Marketplace: <https://marketplace.visualstudio.com/items?itemName=DanielAlonso.kdb-sqltools>
- kdb-sqltools GitHub repository: <https://github.com/dreth/kdb-sqltools>

The extension contributes:

- The `q` language id for `.q` files.
- SQLTools driver registration under driver id `KDB`.
- q run commands in the Command Palette for `.q` files.
- The kdb results panel.

## Start a local q process

For a local connection, start q with a port:

```sh
q -p 5000
```

That process listens on `localhost:5000`. Use this connection target in SQLTools:

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

See [Connections](connections.md) for where to put this JSON and how `database` maps to q namespaces.

## First run

Open a `.q` file and run:

```q
til 5
```

Use `Ctrl+Enter` on Windows/Linux or `Cmd+Enter` on macOS. The result should open in the kdb results panel.
