#!/usr/bin/env bash
# Bake Supabase config into frontend/index.html and deploy to Cloudflare Pages.
# Usage: ./deploy.sh
set -euo pipefail

# Load .env from this directory (https://stackoverflow.com/a/30969768)
SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

: "${SUPABASE_URL:?SUPABASE_URL not set in .env}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY not set in .env}"
: "${CLOUDFLARE_PAGES_PROJECT:=learning-backlog}"

cd "$SCRIPT_DIR"

# Build to a temp dir so we don't mutate the source.
BUILD_DIR=$(mktemp -d -t learning-backlog.XXXX)
echo "==> Building into $BUILD_DIR"
cp -R frontend/* "$BUILD_DIR/"

# Substitute the Supabase config into the meta tags.
# macOS sed -i needs an empty backup arg.
sed -i.bak \
  -e "s|<meta name=\"supabase-url\" content=\"\">|<meta name=\"supabase-url\" content=\"$SUPABASE_URL\">|" \
  -e "s|<meta name=\"supabase-anon-key\" content=\"\">|<meta name=\"supabase-anon-key\" content=\"$SUPABASE_ANON_KEY\">|" \
  "$BUILD_DIR/index.html"
rm -f "$BUILD_DIR/index.html.bak"

echo "==> Deploying to Cloudflare Pages project: $CLOUDFLARE_PAGES_PROJECT"
# Requires `npx wrangler` (Cloudflare's CLI). It'll prompt for OAuth login on
# first use, or pick up CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from env.
npx --yes wrangler@latest pages deploy "$BUILD_DIR" \
  --project-name="$CLOUDFLARE_PAGES_PROJECT" \
  --commit-dirty=true \
  --branch=main

echo "==> Done. Visit your Pages dashboard to grab the URL."
echo "==> https://dash.cloudflare.com/?to=/:account/pages/view/$CLOUDFLARE_PAGES_PROJECT"
