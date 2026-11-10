#!/bin/sh
# Installs the Haram Blocker helper for Chrome on Linux.
#   1. Creates the Python environment (CUDA PyTorch + Demucs) in helper/.venv
#   2. Downloads the AI model once
#   3. Registers the helper with Chrome (native messaging)
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
HELPER="$ROOT/helper"
EXT_ID="dlhalfnkadcmncbhilghjipnpjmaaocb"
HOST_NAME="com.haram_blocker.cleaner"

mkdir -p "$HOME/.local/state/haram-blocker"

if [ ! -x "$HELPER/.venv/bin/python" ]; then
  echo "Creating Python environment (large download, one time)..."
  command -v uv >/dev/null || { echo "Please install uv first: https://docs.astral.sh/uv/"; exit 1; }
  uv venv --python 3.12 "$HELPER/.venv"
  uv pip install --python "$HELPER/.venv/bin/python" torch torchaudio --index-url https://download.pytorch.org/whl/cu128
  uv pip install --python "$HELPER/.venv/bin/python" demucs soundfile numpy
fi

echo "Downloading the AI model (one time)..."
"$HELPER/.venv/bin/python" -c "from demucs.pretrained import get_model; get_model('htdemucs_ft')" 2>/dev/null

MANIFEST=$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "Haram Blocker GPU helper",
  "path": "$HELPER/run.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
)
for dir in "$HOME/.config/google-chrome" "$HOME/.config/chromium" "$HOME/.config/BraveSoftware/Brave-Browser"; do
  if [ -d "$dir" ]; then
    mkdir -p "$dir/NativeMessagingHosts"
    echo "$MANIFEST" > "$dir/NativeMessagingHosts/$HOST_NAME.json"
    echo "Registered helper for $dir"
  fi
done

echo
echo "Done. Now load the extension in Chrome:"
echo "  1. Open chrome://extensions"
echo "  2. Turn on 'Developer mode' (top right)"
echo "  3. Click 'Load unpacked' and choose: $ROOT/extension"
