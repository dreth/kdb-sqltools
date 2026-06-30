# Local Data Server

The kdb results panel can start an opt-in local HTTP server for the current panel result. It is intended for Python, pandas, Plotly, and other local analysis tools that should read the visible result without another q query.

SQLTools is still required for the extension and connection workflow. The local server only exposes data that is already in a kdb results panel.

## Start and stop

Start it from the kdb results panel:

1. Run q into a kdb results panel.
2. Open `Settings`.
3. Expand the collapsed `Data server` section.
4. Use `Start server`.
5. Use `Copy current.csv URL` or `Copy metadata URL`.

When the server is running, the collapsed `Data server` section shows a short `host:port` badge. The tokenized base URL is shown only inside that Settings section.

Command Palette commands are also available:

| Command | Behavior |
| --- | --- |
| `kdb Results: Start Local Data Server` | Starts a server for the active kdb result panel. |
| `kdb Results: Stop Local Data Server` | Stops the active panel's server. |
| `kdb Results: Copy Local Data Server current.csv URL` | Copies the active panel server's `current.csv` URL. |

The server never starts automatically. It binds only to `127.0.0.1`, prefers port `7742`, and falls forward to the next free port if needed. Each server gets a random token in the URL path. The token is not saved and changes when the server is restarted.

The server stops when you press `Stop server`, close the result panel, or the extension deactivates.

## Endpoints

All endpoints are under the random token path:

```text
http://127.0.0.1:<port>/<token>/metadata.json
```

| Endpoint | Output |
| --- | --- |
| `GET /<token>/metadata.json` | Result metadata, visible columns, row count, query label, and endpoint limits. |
| `GET /<token>/current.csv` | Current visible result as CSV with headers. |
| `GET /<token>/current.json` | Current visible result as JSON rows. |
| `GET /<token>/current.ndjson` | Current visible result as newline-delimited JSON. |
| `GET /<token>/slice.csv?rowStart=0&rowCount=1000&colStart=0&colCount=20` | A bounded visible row/column slice as CSV. |
| `GET /<token>/slice.json?rowStart=0&rowCount=1000&colStart=0&colCount=20` | A bounded visible row/column slice as JSON rows. |
| `GET /<token>/selection.csv` | Current webview selection as CSV. |
| `GET /<token>/selection.json` | Current webview selection as JSON rows. |

Hidden and reordered columns are honored. If the panel is sorted, endpoints use the sorted row order. The left row-number display column is not included.

Selection endpoints return a JSON `400` error until the webview has sent a current selection to the extension.

## Guardrails

Full-result endpoints reject visible results above `kdb-sqltools.results.localDataServerFullExportCellLimit`, which defaults to `1000000` cells and can be changed from `Settings` -> `Preferences` or VS Code settings. The copy/export confirmation threshold does not raise this server hard limit. Use `slice.csv` or `slice.json` for large tables.

```json
{
  "kdb-sqltools.results.localDataServerFullExportCellLimit": 1000000
}
```

The setting has a minimum of `1` and no hard upper bound. Raising it can make a large HTTP response materialize in the extension host.

Slice requests validate row and column bounds and are limited to a fixed cell count. Errors are returned as JSON with an `error.code` and `error.message`.

## Python example

```python
import pandas as pd

url = "http://127.0.0.1:7742/<token>/current.csv"
df = pd.read_csv(url)
```

For larger results:

```python
import pandas as pd

url = "http://127.0.0.1:7742/<token>/slice.csv?rowStart=0&rowCount=100000&colStart=0&colCount=10"
df = pd.read_csv(url)
```

`plotly-resampler` remains an external Python workflow: read CSV or JSON from the local server into pandas, then build a Plotly figure in Python. The built-in VS Code chart is intentionally smaller and line-chart-only.
