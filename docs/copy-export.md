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

Large copy and export actions prompt before materializing output.

XLSX export rejects output beyond Excel worksheet limits:

- 1,048,576 rows.
- 16,384 columns.

Parquet export is not implemented yet.
