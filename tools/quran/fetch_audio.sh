#!/usr/bin/env bash
# Download the recitation (Mishary Rashid Alafasy, from EveryAyah.com) of the
# verses in extension/blocker/verses.json. The files are not stored in the
# repository; install.sh runs this.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/extension/blocker/audio"
mkdir -p "$OUT"
for f in $(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(' '.join(sorted({a['audio'] for p in d['passages'] for a in p['ayat']})))" "$ROOT/extension/blocker/verses.json"); do
  [ -s "$OUT/$f" ] && continue
  curl -sfL --retry 3 -o "$OUT/$f.part" "https://everyayah.com/data/Alafasy_64kbps/$f"
  mv "$OUT/$f.part" "$OUT/$f"
done
echo "recitation: $(ls "$OUT" | wc -l) files in $OUT"
