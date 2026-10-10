#!/usr/bin/env bash
# Publish the phone UI to GitHub Pages: https://anthony-sin.github.io/spatial-objects/
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${SPATIAL_REPO:-Anthony-Sin/spatial-objects}"

# Keep the served copy in sync with the source UI files.
cp app.js index.html style.css dist/
cp node_modules/mqtt/dist/mqtt.min.js dist/mqtt.min.js
touch dist/.nojekyll
if [[ -n $(git status --porcelain -- dist) ]]; then
  git add dist
  git commit -m "Update site build"
fi

# Create the repo on first run, then push main.
if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "$REPO" --public --source . --remote origin
fi
branch="$(git branch --show-current)"
git push -u origin "$branch"

# Publish dist/ at the root of the gh-pages branch.
site_commit="$(git subtree split --prefix dist HEAD)"
git push origin "+${site_commit}:refs/heads/gh-pages"

# Enable Pages (POST creates, PUT updates an existing config).
gh api "repos/${REPO}/pages" -X POST -f "source[branch]=gh-pages" -f "source[path]=/" >/dev/null 2>&1 \
  || gh api "repos/${REPO}/pages" -X PUT -f "source[branch]=gh-pages" -f "source[path]=/" >/dev/null

echo "Published: https://$(echo "$REPO" | cut -d/ -f1 | tr '[:upper:]' '[:lower:]').github.io/$(echo "$REPO" | cut -d/ -f2)/"
