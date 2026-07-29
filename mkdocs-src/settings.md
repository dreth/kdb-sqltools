# Settings

Set these in VS Code User or Workspace settings JSON.

## Result target and panel behavior

| Setting | Default | Values | Use |
| --- | --- | --- | --- |
| `kdb-sqltools.results.target` | `kdbPanel` | `kdbPanel`, `sqltools` | Default target for `kdb+: Run q Script` and `kdb+: Run Selection`. |
| `kdb-sqltools.results.kdbPanel.defaultRunMode` | `new` | `new`, `replace` | Whether default kdb panel runs open a new result tab or reuse an existing one. |
| `kdb-sqltools.results.kdbPanel.initialViewColumn` | `active` | `active`, `beside`, `one`, `two`, `three` | Editor group for the first kdb result panel. Later new result tabs open beside existing kdb result tabs when possible. |
| `kdb-sqltools.results.kdbPanel.arrayDisplayFormat` | `commaSpace` | `commaSpace`, `space`, `raw` | Array/list cell display. |
| `kdb-sqltools.results.kdbPanel.functionDisplayStrategy` | `qText` | `grid`, `qText`, `table`, `text` | Top-level function/lambda/projection display. |
| `kdb-sqltools.results.kdbPanel.dictionaryDisplayStrategy` | `grid` | `grid`, `qText`, `table`, `text` | Top-level dictionary display. |
| `kdb-sqltools.results.kdbPanel.listDisplayStrategy` | `grid` | `grid`, `qText`, `table`, `text` | Top-level general/mixed/object list display. |
| `kdb-sqltools.results.kdbPanel.objectDisplayStrategy` | `grid` | `grid`, `qText`, `table`, `text` | Top-level plain object display. |
| `kdb-sqltools.performance.trace` | `false` | `true`, `false` | Logs query timing and memory snapshots to the extension host console with the `[kdb-sqltools:perf]` prefix. |

There is no setting that auto-starts the local data server. Start it explicitly from the kdb panel `Settings` area or the Command Palette.

Array display examples:

| Value | Display |
| --- | --- |
| `commaSpace` | `1, 2, 3` |
| `space` | `1 2 3` |
| `raw` | `[1 2 3]` where q-like bracketed display is available |

Non-table result strategy values:

| Value | Display |
| --- | --- |
| `grid` | Existing synthetic grid/table form. |
| `qText` | Deterministic q-like output in a plain text viewer. Normal list/object output is rendered fully; only very large text hits a character safety cap and shows `[truncated]`. |
| `table` | Alias for `grid`. |
| `text` | Alias for `qText`. |

True q tables and keyed tables always use the grid. Function source is shown only if it is available in the decoded IPC payload. If IPC only supplies a function marker, the panel shows a source-unavailable message; return `string f` or `.Q.s f` from q when exact source/default q text is required.

## Charting

| Setting | Default | Use |
| --- | --- | --- |
| `kdb-sqltools.results.kdbPanel.chartMaxSourceRows` | `2000000` | Maximum source rows scanned for built-in charting before rejecting a chart request. The minimum is `1`; there is no hard upper bound. |
| `kdb-sqltools.results.kdbPanel.chartDecimalPlaces` | `4` | Decimal places for chart numeric axis ticks, tooltips, legend/live values, box statistics, and candlestick OHLC values. Values are clamped to `0` through `12`; very large or very small nonzero numbers use scientific notation with this precision. |
| `kdb-sqltools.results.kdbPanel.chartZoomMinSampledPoints` | `3000` | Deprecated compatibility key; ignored. Refined ranges use the fixed 3,000-through-7,000 density contract. |
| `kdb-sqltools.results.kdbPanel.chartZoomMaxSampledPoints` | `7000` | Deprecated compatibility key; ignored. Ranges above 7,000 eligible rows use a fixed target of about 7,000 points. |

Very large values can make chart rendering slow or temporarily block the extension host, especially with multiple y columns. For very large data, prefer the local data server or sliced results.

## Panel size and density

| Setting | Default | Use |
| --- | --- | --- |
| `kdb-sqltools.results.density` | `standard` | Active density preset: `compact`, `standard`, or `comfortable`. |
| `kdb-sqltools.results.columnWidths` | `{}` | Extension-managed sparse map of persisted manual widths keyed by zero-based source-column position. Dragging a column updates only its position. |
| `kdb-sqltools.results.autoFitColumns` | `true` | Persist the Auto-fit checkbox. When `false`, no automatic width calculation runs. |
| `kdb-sqltools.results.autoFitMode` | `wholeResult` | Auto-fit scope: stable complete-result `wholeResult`, or viewport-adaptive `visibleRows`. |
| `kdb-sqltools.results.compact.cellWidth` | `140` | Compact density cell width in pixels. |
| `kdb-sqltools.results.compact.rowHeight` | `24` | Compact density row height in pixels. |
| `kdb-sqltools.results.compact.fontSize` | `0` | Compact density font size. `0` uses the VS Code default. |
| `kdb-sqltools.results.standard.cellWidth` | `160` | Standard density cell width in pixels. |
| `kdb-sqltools.results.standard.rowHeight` | `28` | Standard density row height in pixels. |
| `kdb-sqltools.results.standard.fontSize` | `0` | Standard density font size. `0` uses the VS Code default. |
| `kdb-sqltools.results.comfortable.cellWidth` | `180` | Comfortable density cell width in pixels. |
| `kdb-sqltools.results.comfortable.rowHeight` | `32` | Comfortable density row height in pixels. |
| `kdb-sqltools.results.comfortable.fontSize` | `0` | Comfortable density font size. `0` uses the VS Code default. |
| `kdb-sqltools.results.cellWidth` | `160` | Legacy fallback cell width. Density-specific settings are used first. |
| `kdb-sqltools.results.rowHeight` | `28` | Legacy fallback row height. Density-specific settings are used first. |
| `kdb-sqltools.results.fontSize` | `0` | Legacy fallback font size. Density-specific settings are used first. |

`wholeResult` measures the widest displayed header/value in every row, including array/list values outside the virtual viewport, and therefore remains stable while scrolling. `visibleRows` preserves adaptive fitting from the currently rendered rows. Manual positional widths take precedence over auto-fit.

The panel's `Cell width` textbox is an all-column preset control. Changing it or switching density clears/replaces positional manual widths for every data column, including column zero. Dragging a column then writes a new authoritative value for only that source position. The position mapping survives panel and VS Code recreation and does not change when columns are hidden or visually reordered.

## Copy, export, and warnings

| Setting | Default | Use |
| --- | --- | --- |
| `kdb-sqltools.results.showRowIndex` | `true` | Show the left row-number column in the panel. |
| `kdb-sqltools.results.includeHeaders` | `true` | Include column headers by default when copying or exporting. |
| `kdb-sqltools.results.includeRowIndex` | `true` | Include 1-based row numbers by default when copying or exporting. |
| `kdb-sqltools.results.hideLargeResultWarnings` | `false` | Hide large-result guardrail messages in the panel. |
| `kdb-sqltools.results.hideLargeSortWarnings` | `false` | Skip large-result sort confirmation warnings. |
| `kdb-sqltools.results.copyExportConfirmCellThreshold` | `1000000` | Selected-cell threshold that triggers copy/export confirmation. Minimum `1`; no hard upper bound. |
| `kdb-sqltools.results.localDataServerFullExportCellLimit` | `1000000` | Visible-cell limit for local data server full-result `current.csv`, `current.json`, and `current.ndjson` exports. Minimum `1`; no hard upper bound. |
| `kdb-sqltools.results.elapsedTimeDisplay` | `auto` | Use `auto` or `milliseconds` for elapsed time display. |

## Example

```json
{
  "kdb-sqltools.results.target": "kdbPanel",
  "kdb-sqltools.results.kdbPanel.defaultRunMode": "replace",
  "kdb-sqltools.results.kdbPanel.arrayDisplayFormat": "space",
  "kdb-sqltools.results.kdbPanel.functionDisplayStrategy": "qText",
  "kdb-sqltools.results.kdbPanel.dictionaryDisplayStrategy": "qText",
  "kdb-sqltools.results.kdbPanel.listDisplayStrategy": "grid",
  "kdb-sqltools.results.kdbPanel.objectDisplayStrategy": "grid",
  "kdb-sqltools.results.includeHeaders": true,
  "kdb-sqltools.results.includeRowIndex": true,
  "kdb-sqltools.results.copyExportConfirmCellThreshold": 1000000,
  "kdb-sqltools.results.localDataServerFullExportCellLimit": 1000000
}
```
