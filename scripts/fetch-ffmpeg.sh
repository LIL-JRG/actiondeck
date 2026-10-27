#!/bin/sh
# Descarga ffmpeg y ffprobe estáticos para Apple Silicon (builds de Martin
# Riedl, enlazados desde ffmpeg.org), comprueba su SHA-256 y los deja donde
# Tauri los busca para meterlos en la app (`externalBin`).
set -eu

VERSION="1789931890_9.0.2"
BASE="https://ffmpeg.martin-riedl.de/download/macos/arm64/$VERSION"
DEST="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/binaries"
TRIPLE="aarch64-apple-darwin"

mkdir -p "$DEST"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for tool in ffmpeg ffprobe; do
  target="$DEST/$tool-$TRIPLE"
  if [ -x "$target" ]; then
    echo "$tool: ya está"
    continue
  fi
  echo "$tool: descargando $VERSION"
  curl -fsSL -o "$work/$tool.zip" "$BASE/$tool.zip"
  expected="$(curl -fsSL "$BASE/$tool.zip.sha256" | awk '{print $1}')"
  actual="$(shasum -a 256 "$work/$tool.zip" | awk '{print $1}')"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "$tool: el SHA-256 no coincide ($actual)" >&2
    exit 1
  fi
  unzip -q -o "$work/$tool.zip" -d "$work"
  mv "$work/$tool" "$target"
  chmod +x "$target"
done
