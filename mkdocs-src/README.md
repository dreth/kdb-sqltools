# Documentation Maintainer Notes

The public documentation site is built with MkDocs Material from the Markdown files in this directory. MkDocs writes the generated static site to `../docs/`.

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
pip install -r mkdocs-src/requirements.txt
mkdocs build --strict
python .github/scripts/clean-mkdocs-output.py docs
```

For local preview:

```sh
mkdocs serve
```

## GitHub Pages

Repository Pages is legacy-configured to serve branch `main`, path `/docs`, with `build_type: legacy`. The repository token cannot change that setting to workflow mode, so the generated `/docs` static site is committed.

When changing documentation, edit Markdown under `mkdocs-src/`, run `mkdocs build --strict`, normalize the generated output with `.github/scripts/clean-mkdocs-output.py`, and commit both the source changes and generated `/docs` output. Do not edit generated `/docs` HTML by hand.

Keep `mkdocs-src/CNAME` with:

```text
kdb-sqltools.dac.sg
```

MkDocs copies that file into `docs/` during the build so GitHub Pages preserves the custom domain.
