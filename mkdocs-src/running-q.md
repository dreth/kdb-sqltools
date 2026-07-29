# Running q

The extension executes q text. It does not parse or translate SQL.

## Default behavior

`kdb+: Run q Script` and `kdb+: Run Selection` use the configured result target:

```json
"kdb-sqltools.results.target": "kdbPanel"
```

The default is `kdbPanel`.

`Run Selection` sends the selected text exactly. If there is no selection, it sends the current physical line. A blank current line shows the normal no-code warning. `Run q Script` sends the whole active editor document.

For multi-line, lambda, or blank-line-bounded block execution, select the intended text explicitly or use the explicit `Run Selection or q Block` commands. The q Block commands send the selected text exactly, or the current q block bounded by blank lines when there is no selection.

The SQLTools connection `database` field is the q namespace for raw editor runs. With `database: "."`, text is sent as written. With `database: ".analytics"`, text is evaluated inside `.analytics` and the previous q namespace is restored afterwards, so `a` resolves as `.analytics.a`.

## kdb panel connection selection

In a fresh session, extension-owned kdb-panel runs use the only configured kdb connection without opening a picker. When multiple kdb connections are available and there is no valid session choice, a panel run asks which one to use, then silently reuses that connection for later replace, new-panel, chart, selection/current-line/block, and file runs.

Use `kdb+: Select kdb Panel Query Connection` to always open the picker and change future panel runs without executing q. Canceling the selector keeps a still-valid current choice. The choice is held only for the current Extension Host session, so a new session asks again when multiple connections exist. Removing the selected connection or changing it to a non-kdb driver also invalidates the choice and makes the next panel run prompt again.

Only a non-secret connection ID is kept in this session target. When a panel query runs, password resolution happens after the target is selected or reused; the selector command itself does not request or cache a password. Commands targeting SQLTools Results continue to use SQLTools' own connection-selection behavior.

## Canceling a run

While a q run is loading in the kdb results panel, use the panel's `Cancel` button or the VS Code progress notification's cancel action. Cancellation stops VS Code waiting for that run, tears down the active q IPC connection, and leaves a clear canceled message in the panel.

Cancellation is best-effort on the server side. Depending on the q process, gateway, and query being executed, work that already reached the server may continue briefly or complete even after the client connection is closed.

## Keybindings

| Keybinding | macOS | Command | Result behavior |
| --- | --- | --- | --- |
| `Ctrl+Enter` | `Cmd+Enter` | `kdb+: Run Selection in kdb Panel (Replace)` | Reuse the current or first kdb result tab. |
| `Ctrl+Shift+Enter` | `Cmd+Shift+Enter` | `kdb+: Run Selection in New kdb Panel` | Open an independent kdb result tab. |
| `Ctrl+Alt+Enter` | `Cmd+Alt+Enter` | `kdb+: Run q Script in kdb Panel (Replace)` | Run the whole file and reuse an existing kdb result tab. |
| `Ctrl+Alt+C` | `Cmd+Alt+C` | `kdb+: Run Selection and Chart` | Run the selected text, or current physical line, in replace mode and open/render the chart panel. |

In `.q` editors, `Ctrl+Enter` / `Cmd+Enter` always routes both single-line and multi-line selections to the kdb panel in replace mode.

Use `kdb+: Open kdb Keyboard Shortcuts` to edit these bindings in VS Code. Extension settings cannot define arbitrary VS Code keybindings.

## Commands

| Command | Target |
| --- | --- |
| `kdb+: Run q Script` | Configured default target. |
| `kdb+: Run Selection` | Configured default target. |
| `kdb+: Run Selection or q Block` | Configured default target, with q-block fallback. |
| `kdb+: Select kdb Panel Query Connection` | Select the session target for future extension-owned kdb-panel runs without executing q. |
| `kdb+: Run q Script in kdb Panel` | kdb panel, using configured default run mode. |
| `kdb+: Run Selection in kdb Panel` | kdb panel, using configured default run mode. |
| `kdb+: Run Selection or q Block in kdb Panel` | kdb panel, using configured default run mode, with q-block fallback. |
| `kdb+: Run q Script in kdb Panel (Replace)` | kdb panel, replace mode. |
| `kdb+: Run Selection in kdb Panel (Replace)` | kdb panel, replace mode. |
| `kdb+: Run Selection or q Block in kdb Panel (Replace)` | kdb panel, replace mode, with q-block fallback. |
| `kdb+: Run Selection and Chart` | kdb panel, replace mode, then chart restored or default eligible columns. |
| `kdb+: Run Selection or q Block and Chart` | kdb panel, replace mode, with q-block fallback, then chart restored or default eligible columns. |
| `kdb+: Run q Script in New kdb Panel` | kdb panel, new result tab. |
| `kdb+: Run Selection in New kdb Panel` | kdb panel, new result tab. |
| `kdb+: Run Selection or q Block in New kdb Panel` | kdb panel, new result tab, with q-block fallback. |
| `kdb+: Run q Script in SQLTools Results` | SQLTools result grid. |
| `kdb+: Run Selection in SQLTools Results` | SQLTools result grid. |
| `kdb+: Run Selection or q Block in SQLTools Results` | SQLTools result grid, with q-block fallback. |
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
