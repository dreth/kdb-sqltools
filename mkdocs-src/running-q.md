# Running q

The extension executes q text. It does not parse or translate SQL.

## Default behavior

`kdb+: Run q Script` and `kdb+: Run Selection` use the configured result target:

```json
"kdb-sqltools.results.target": "kdbPanel"
```

The default is `kdbPanel`.

`Run Selection` sends the selected text exactly. If there is no selection, it sends the current q block bounded by blank lines. A blank current line shows the normal no-code warning. `Run q Script` sends the whole active editor document.

## Canceling a run

While a q run is loading in the kdb results panel, use the panel's `Cancel` button or the VS Code progress notification's cancel action. Cancellation stops VS Code waiting for that run, tears down the active q IPC connection, and leaves a clear canceled message in the panel.

Cancellation is best-effort on the server side. Depending on the q process, gateway, and query being executed, work that already reached the server may continue briefly or complete even after the client connection is closed.

## Keybindings

| Keybinding | macOS | Command | Result behavior |
| --- | --- | --- | --- |
| `Ctrl+Enter` | `Cmd+Enter` | `kdb+: Run Selection in kdb Panel (Replace)` | Reuse the current or first kdb result tab. |
| `Ctrl+Shift+Enter` | `Cmd+Shift+Enter` | `kdb+: Run Selection in New kdb Panel` | Open an independent kdb result tab. |
| `Ctrl+Alt+Enter` | `Cmd+Alt+Enter` | `kdb+: Run q Script in kdb Panel (Replace)` | Run the whole file and reuse an existing kdb result tab. |
| `Ctrl+Alt+C` | `Cmd+Alt+C` | `kdb+: Run Selection and Chart` | Run the selection, or current q block, in replace mode and open/render the chart panel. |

Use `kdb+: Open kdb Keyboard Shortcuts` to edit these bindings in VS Code. Extension settings cannot define arbitrary VS Code keybindings.

## Commands

| Command | Target |
| --- | --- |
| `kdb+: Run q Script` | Configured default target. |
| `kdb+: Run Selection` | Configured default target. |
| `kdb+: Run q Script in kdb Panel` | kdb panel, using configured default run mode. |
| `kdb+: Run Selection in kdb Panel` | kdb panel, using configured default run mode. |
| `kdb+: Run q Script in kdb Panel (Replace)` | kdb panel, replace mode. |
| `kdb+: Run Selection in kdb Panel (Replace)` | kdb panel, replace mode. |
| `kdb+: Run Selection and Chart` | kdb panel, replace mode, then chart restored or default eligible columns. |
| `kdb+: Run q Script in New kdb Panel` | kdb panel, new result tab. |
| `kdb+: Run Selection in New kdb Panel` | kdb panel, new result tab. |
| `kdb+: Run q Script in SQLTools Results` | SQLTools result grid. |
| `kdb+: Run Selection in SQLTools Results` | SQLTools result grid. |
| `kdb Results: Start Local Data Server` | Active kdb panel's current result, opt-in local server. |
| `kdb Results: Stop Local Data Server` | Stops the active kdb panel's local server. |
| `kdb Results: Copy Local Data Server current.csv URL` | Copies the active kdb panel server's CSV URL. |

## SQLTools result grid opt-in

To make SQLTools' own result grid the default target:

```json
"kdb-sqltools.results.target": "sqltools"
```

The explicit `... in SQLTools Results` commands are available regardless of the default.

SQLTools may open `*.session.sql` editor documents when using its own result target. That is SQLTools behavior. Use the kdb panel commands to avoid that session-file workflow.
