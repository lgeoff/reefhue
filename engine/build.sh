#!/usr/bin/env bash
# Standard build: needs `rustup target add wasm32-unknown-unknown` once.
set -euo pipefail
cd "$(dirname "$0")"
RUSTFLAGS="-C link-arg=--export=__heap_base -C link-arg=--export=__data_end" \
  cargo build --release --target wasm32-unknown-unknown
mkdir -p ../web
cp target/wasm32-unknown-unknown/release/reefhue_engine.wasm ../web/engine.wasm
ls -l ../web/engine.wasm
