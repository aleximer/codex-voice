#!/bin/sh
# Builds the floating ring into ring/codex-voice-ring (a symlink into the Xcode build products, which also
# hold VoiceRingKit's shader bundle). Xcode is required for the Metal shader; CODEX_VOICE_XCODE picks one.
set -e
cd "$(dirname "$0")"
XCODE="${CODEX_VOICE_XCODE:-$(ls -d /Applications/Xcode*.app 2>/dev/null | head -1)}"
[ -n "$XCODE" ] || { echo "codex-voice ring: Xcode not found; the voice will open in a browser instead." >&2; exit 0; }
DEVELOPER_DIR="$XCODE/Contents/Developer" xcodebuild -quiet -scheme codex-voice-ring -configuration Release \
  -destination 'platform=macOS' -derivedDataPath .build/xcode build
ln -sf .build/xcode/Build/Products/Release/codex-voice-ring codex-voice-ring
