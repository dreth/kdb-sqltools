# Documentation Site

This directory contains the static GitHub Pages site. The workflow in `.github/workflows/pages.yml` uploads `./docs` directly, with no build step.

To enable deployment, set the repository Pages source to GitHub Actions:

1. Open repository Settings.
2. Go to Pages.
3. Under Build and deployment, choose GitHub Actions.

For a custom domain, confirm the domain first, then add `docs/CNAME` containing only the domain name. Do not add a real `docs/CNAME` before the domain is ready.
