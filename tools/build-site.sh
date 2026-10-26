#!/bin/sh
# Builds the deployable site into _site/ (Cloudflare Pages and GitHub Actions
# both run this). Uses the committed web/engine.wasm.
#   sh tools/build-site.sh [version]
set -e
cd "$(dirname "$0")/.."
VER=${1:-${CF_PAGES_COMMIT_SHA:-${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo dev)}}}
VER=$(printf '%s' "$VER" | cut -c1-7)
PY=$(command -v python3 || command -v python)
rm -rf _site && mkdir -p _site
cp -r web/. _site/
# version label in the page and the single-file builds
sed -i.bak "s/name=\"reefhue-version\" content=\"dev\"/name=\"reefhue-version\" content=\"$VER\"/" _site/index.html && rm -f _site/index.html.bak
cp web/index.html /tmp/reefhue-index.html && cp _site/index.html web/index.html
"$PY" tools/bundle.py
cp /tmp/reefhue-index.html web/index.html
cp dist/reefhue.html _site/reefhue-single-file.html
touch _site/.nojekyll
"$PY" tools/cachebust.py _site "$VER"
echo "built _site for $VER"
