# Documentation Maintainer Notes

The public documentation site is built with MkDocs Material from the Markdown files in this directory.

## Project links

- kdb-sqltools Marketplace: <https://marketplace.visualstudio.com/items?itemName=DanielAlonso.kdb-sqltools>
- kdb-sqltools GitHub: <https://github.com/dreth/kdb-sqltools>
- SQLTools Marketplace: <https://marketplace.visualstudio.com/items?itemName=mtxr.sqltools>
- SQLTools docs: <https://vscode-sqltools.mteixeira.dev/>
- SQLTools GitHub: <https://github.com/mtxr/vscode-sqltools>

## Local build

```sh
python3 -m venv /tmp/kdb-docs-venv
. /tmp/kdb-docs-venv/bin/activate
pip install -r docs/requirements.txt
mkdocs build --strict
```

For local preview:

```sh
mkdocs serve
```

## GitHub Pages

The Pages workflow builds MkDocs and uploads the generated `site/` directory. Repository Pages should use GitHub Actions as the source.

If the public site appears as raw Markdown with no left sidebar, set Settings -> Pages -> Build and deployment -> Source to `GitHub Actions`, not branch `/docs`.

Keep `docs/CNAME` with:

```text
kdb-sqltools.dac.sg
```

MkDocs copies that file into `site/` during the build so GitHub Pages preserves the custom domain.
