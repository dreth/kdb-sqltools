# kdb-sqltools

`kdb-sqltools` is a VS Code driver for [SQLTools](https://vscode-sqltools.mteixeira.dev/) that connects to kdb+/q over q IPC.

## Important links

- kdb-sqltools: [Marketplace](https://marketplace.visualstudio.com/items?itemName=DanielAlonso.kdb-sqltools) / [GitHub](https://github.com/dreth/kdb-sqltools)
- SQLTools: [Marketplace](https://marketplace.visualstudio.com/items?itemName=mtxr.sqltools) / [Documentation](https://vscode-sqltools.mteixeira.dev/) / [GitHub](https://github.com/mtxr/vscode-sqltools)

It sends q text to the remote process. It does not translate ANSI SQL to q. Use q, qSQL, and normal q expressions:

```q
select from trade where sym=`AAPL
meta trade
tables `.analytics
```

## Requirements

- VS Code.
- [SQLTools](https://marketplace.visualstudio.com/items?itemName=mtxr.sqltools), the required base extension.
- A kdb+/q process listening on a TCP port, for example:

```sh
q -p 5000
```

## Common workflow

1. Start q with a port.
2. Add a SQLTools connection that uses the `KDB` driver.
3. Open a `.q` file.
4. Run a selection or the current line with `Ctrl+Enter` or `Cmd+Enter`.
5. Inspect the result in the kdb results panel.

The kdb results panel is the default result target. SQLTools' own result grid remains available through explicit commands or the `kdb-sqltools.results.target` setting.

## Documentation map

- [Installation](installation.md): required extensions and first setup.
- [Connections](connections.md): local q, SQLTools JSON, namespaces, and connection scope.
- [Running q](running-q.md): commands, keybindings, default target, and SQLTools opt-in.
- [Results panel](results-panel.md): selection, sorting, search, hidden columns, virtualization, and result placement.
- [Charting roadmap](charting-roadmap.md): future charting architecture, library tradeoffs, and downsampling plan.
- [Copy and export](copy-export.md): supported formats and guardrails.
- [Settings](settings.md): setting keys, defaults, and practical effects.
- [Troubleshooting](troubleshooting.md): known limits and common failure modes.
- [Feedback](feedback.md): bug reports, feature requests, and general feedback.
