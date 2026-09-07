#!/usr/bin/env bash
set -euo pipefail

target="${1:-all}"
root_dir="$(cd "$(dirname "$0")/.." && pwd)"
release_dir="$root_dir/release"
files=(manifest.json early-filter.js content.js content.css page-bridge.js popup.html popup.js ui.css README.md LICENSE PRIVACY.md)

package_target() {
  local browser="$1"
  local stage_dir="$release_dir/yougame-forum-filter-$browser"
  local archive="$release_dir/yougame-forum-filter-$browser"
  rm -rf "$stage_dir"
  mkdir -p "$stage_dir"
  for file in "${files[@]}"; do
    if [[ -d "$root_dir/$file" ]]; then
      cp -R "$root_dir/$file" "$stage_dir/$file"
    else
      cp "$root_dir/$file" "$stage_dir/$file"
    fi
  done
  if [[ "$browser" == "firefox" ]]; then
    cp "$root_dir/manifests/firefox.json" "$stage_dir/manifest.json"
    (cd "$stage_dir" && zip -qr "$archive.xpi" .)
  else
    (cd "$stage_dir" && zip -qr "$archive.zip" .)
  fi
}

case "$target" in
  chrome|firefox) package_target "$target" ;;
  all) package_target chrome; package_target firefox ;;
  *) echo "Usage: $0 [chrome|firefox|all]" >&2; exit 2 ;;
esac

echo "Packages are in $release_dir"
