#!/bin/sh
# Link the PocketJS SDK checkout used for admission/build/frames.
# Override with POCKETJS_SDK=/path/to/.pocketjs-star-drift-sdk.
set -eu
SDK=${POCKETJS_SDK:-$HOME/development/.pocketjs-star-drift-sdk}
[ -d "$SDK/framework/src" ] || { echo "PocketJS SDK not found: $SDK" >&2; exit 1; }
mkdir -p node_modules/@pocketjs
ln -sfn "$SDK" node_modules/@pocketjs/framework
echo "linked node_modules/@pocketjs/framework -> $SDK"
