# Results Panel

The kdb results panel is the default target for q runs. It uses this extension's direct driver path and keeps focus in the q editor while results update.

## Result tabs

Default kdb-panel runs open a new result tab unless this setting is changed:

```json
"kdb-sqltools.results.kdbPanel.defaultRunMode": "replace"
```

Replace commands reuse the current or first existing kdb result tab. New commands open an independent result tab.

New result grouping keeps new kdb result tabs beside existing kdb result tabs when one is already present. The first panel uses `kdb-sqltools.results.kdbPanel.initialViewColumn`.

## Large results

The panel virtualizes rows and columns. It transfers only the visible cell window from the extension host to the webview, reducing DOM work for large tables.

The q IPC response is still fully materialized in extension memory before display. Use q-side limits for truly large results:

```q
1000#select from trade where date=.z.D
```

Very large results show a non-blocking warning. Copy, export, search, and sort may require additional work because they operate beyond the currently visible cells.

## Column controls

| Feature | Behavior |
| --- | --- |
| Resize | Drag column edges to set widths for the current panel session. |
| Auto-fit | Sizes visible columns from headers and currently rendered cells as you scroll. |
| Reorder | Header mode `Drag` lets you drag headers to reorder visible columns. A drag cue marks the insertion position. |
| Select columns | Header mode `Select` turns header clicks into whole-column selection. |
| Sort | Header mode `Sort` cycles ascending, descending, and original order. Sorting uses visible cell text. |
| Hidden columns | Hide columns from the panel settings menu for the current panel session. Reset restores all columns. |

Column reorder, sort, search, copy, and export use the current visible column order. Hidden-column choices persist only for later results in the same panel when the full column list matches.

## Selection

The panel supports:

- Cell ranges.
- Whole-row selection.
- Whole-column selection.
- Full table selection.
- Deselect all.

With no selection, copy and export use all cells.

## Search

Toolbar search runs in the extension against visible columns only. It returns capped row-match metadata to the webview, so the panel does not need to transfer every cell to search. The search status indicates capped or partial scans.

## Array display formats

`kdb-sqltools.results.kdbPanel.arrayDisplayFormat` controls array and list cell display:

| Value | Example |
| --- | --- |
| `commaSpace` | `1, 2, 3` |
| `space` | `1 2 3` |
| `raw` | `[1 2 3]` where q-like bracketed display is available |

Text copy/export formats use this display text. JSON and NDJSON keep structured values.
