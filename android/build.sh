#!/bin/sh
# Rebuild X's Android app as a client of this instance, sign it, and install it
# on a connected phone. The app itself is X's and lives OUTSIDE this repo
# (default ~/Projects/xitter-android); only this script and patch.ts are ours.
#
# Prereqs (paths overridable by env):
#   APKDIR   unpacked base.apk (apktool d)        ~/Projects/xitter-android/apktool
#   SPLITS   dir with the original split APKs      ~/Projects/xitter-android/original/12.34.0
#   APKTOOL  apktool jar                           ~/Projects/xitter-android/tools/apktool.jar
#   SIGNER   uber-apk-signer jar                   ~/Projects/xitter-android/tools/uber-apk-signer.jar
#   ADB      adb binary                            ~/Downloads/ADB/adb.exe
#
# usage: sh android/build.sh           # patch, rebuild, sign, install
#        sh android/build.sh --no-install
set -e

ROOT="$HOME/Projects/xitter-android"
APKDIR="${APKDIR:-$ROOT/apktool}"
SPLITS="${SPLITS:-$ROOT/original/12.34.0}"
APKTOOL="${APKTOOL:-$ROOT/tools/apktool.jar}"
SIGNER="${SIGNER:-$ROOT/tools/uber-apk-signer.jar}"
ADB="${ADB:-$HOME/Downloads/ADB/adb.exe}"
OUT="$ROOT/out"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== patching smali (root checks off, pinning off) =="
bun "$HERE/patch.ts" "$APKDIR"

echo "== rebuilding base.apk =="
rm -rf "$OUT"; mkdir -p "$OUT"
java -Xmx6g -jar "$APKTOOL" b "$APKDIR" -o "$OUT/base.apk"

# the config splits are unchanged, so copy them next to the rebuilt base
cp "$SPLITS"/split_*.apk "$OUT"/

echo "== signing all parts with one debug key =="
java -jar "$SIGNER" --apks "$OUT" --allowResign --overwrite

if [ "$1" = "--no-install" ]; then echo "built in $OUT (not installed)"; exit 0; fi

echo "== installing (install-multiple) =="
# shellcheck disable=SC2046
MSYS_NO_PATHCONV=1 "$ADB" install-multiple -r $(ls "$OUT"/*.apk) || {
	echo "install failed — if it's a signature clash with the real X app, uninstall it first:"
	echo "  $ADB uninstall com.twitter.android   (this removes your real X and its login)"
	exit 1
}
echo "done"
