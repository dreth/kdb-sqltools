# Change Log

## 0.1.0

- Made the kdb results panel the default result target for q file/block runs while keeping SQLTools results commands/settings available.
- Expanded kdb panel selection to ranges, rows, columns, and all cells.
- Added copy/export formats for TSV, CSV, JSON, NDJSON, and HTML, plus real XLSX export.
- Added minimal kdb panel cosmetics for cell width, row height, font size, and density.
- Documented SQLTools `.session.sql` behavior and that Parquet export is unavailable in this build.

## 0.0.9

- Reworked optional kdb results panel grid rendering to create DOM cells directly instead of using `innerHTML`/inline `style=` strings, fixing collapsed rows/columns and broken visible-cell selection in VS Code webviews.

## 0.0.8

- Fixed optional kdb results panel cells collapsing/stacking in VS Code webviews by allowing the panel's dynamic virtual-grid positioning styles.

## 0.0.7

- Added optional kdb results panel mode with windowed webview transfer and virtualized rendering while keeping SQLTools results as the default.
- Added range selection and TSV copy support for the optional kdb panel.
- Documented SQLTools User/global versus workspace connection settings behavior.
- Added `kdb+: Copy Example Global Connection Settings` to help users create a persistent User-scope kdb connection.
