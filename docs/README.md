# Documentation Maintainer Notes

The public documentation site is built with MkDocs Material from the Markdown files in this directory.

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

Keep `docs/CNAME` with:

```text
kdb-sqltools.dac.sg
```

MkDocs copies that file into `site/` during the build so GitHub Pages preserves the custom domain.
