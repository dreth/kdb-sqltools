# Copy and Export

Copy and export operate on the current selection. With no selection, they use the full result.

## Formats

| Format | Copy | Export | Notes |
| --- | --- | --- | --- |
| TSV | Yes | Yes | Useful for spreadsheets and terminals. |
| CSV | Yes | Yes | Quoted as needed. |
| Markdown | Yes | Yes | Markdown table output. |
| JSON | Yes | Yes | Structured JSON array. |
| NDJSON | Yes | Yes | One JSON object per row. |
| HTML | Yes | Yes | HTML table output. |
| XLSX | No | Yes | Writes a real `.xlsx` workbook. Copy is disabled. |

Right-click `Copy` in the table viewport uses the same selected range and copy settings as `Ctrl+C` or `Cmd+C`.

## Headers and row numbers

These settings control default copy/export output:

```json
{
  "kdb-sqltools.results.includeHeaders": true,
  "kdb-sqltools.results.includeRowIndex": true
}
```

The panel settings menu can also update them.

## Display text vs structured values

Text formats use cell display text, including the configured array display format.

JSON and NDJSON keep structured values where the driver has structured values available. Duplicate selected column names receive deterministic `_2`, `_3`, and later suffixes so values are never overwritten. A row-number column also receives a collision-safe name.

Visible grid truncation and qText display formatting never change copied or exported source values.

## Guardrails

Large copy and export actions prompt before materializing output. The selected-cell confirmation threshold defaults to `1000000` and can be changed in the panel `Settings` -> `Preferences` section or with:

```json
{
  "kdb-sqltools.results.copyExportConfirmCellThreshold": 1000000
}
```

The setting has a minimum of `1`, but it controls confirmation only. Hard safety limits always apply:

- Clipboard output is limited to 15 MiB. Larger realized output offers file export or cancel; there is no bypass.
- Text export is limited to 5,000,000 output cells, 100,000 output columns, 8,388,608 characters in one cell, and 128 MiB of realized UTF-8 output.
- qText uses the same 15 MiB clipboard and 128 MiB file limits.
- XLSX is limited to 1,000,000 output cells, 32,767 characters in one cell, and 64 MiB of uncompressed worksheet XML, in addition to Excel's sheet dimensions.

Local data server full-result `current.csv`, `current.json`, and `current.ndjson` exports use a separate configurable limit: `kdb-sqltools.results.localDataServerFullExportCellLimit`. The Data server section shows a reminder because raising the copy/export confirmation threshold does not raise the local server hard limit.

XLSX export rejects output beyond Excel worksheet limits:

- 1,048,576 rows.
- 16,384 columns.

Parquet export is not implemented yet.
