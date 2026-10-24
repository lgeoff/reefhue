#!/usr/bin/env bash
# Build engine.wasm WITHOUT the wasm32 standard library (no network needed).
# Normal builds should use ./build.sh instead. See src/minicore.rs.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../web
RUSTC_BOOTSTRAP=1 rustc src/lib.rs \
  --crate-name reefhue_engine --edition 2021 --crate-type cdylib \
  --target wasm32-unknown-unknown --cfg minicore \
  -C opt-level=3 -C panic=abort -C overflow-checks=off -C debug-assertions=off \
  -C lto=fat -C codegen-units=1 -C strip=symbols \
  -C link-arg=--export=__heap_base -C link-arg=--export=__data_end \
  -A internal_features \
  -o ../web/engine.wasm
ls -l ../web/engine.wasm
