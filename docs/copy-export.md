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

JSON and NDJSON keep structured values where the driver has structured values available.

## Guardrails

Large copy and export actions prompt before materializing output. The selected-cell confirmation threshold defaults to `1000000` and can be changed in the panel `Settings` -> `Preferences` section or with:

```json
{
  "kdb-sqltools.results.copyExportConfirmCellThreshold": 1000000
}
```

The setting has a minimum of `1` and no hard upper bound. Raising it can make very large copy/export actions run without prompting and may temporarily block the extension host.

Local data server full-result `current.csv`, `current.json`, and `current.ndjson` exports use a separate configurable limit: `kdb-sqltools.results.localDataServerFullExportCellLimit`. The Data server section shows a reminder because raising the copy/export confirmation threshold does not raise the local server hard limit.

XLSX export rejects output beyond Excel worksheet limits:

- 1,048,576 rows.
- 16,384 columns.

Parquet export is not implemented yet.
