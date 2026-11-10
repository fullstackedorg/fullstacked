#!/bin/sh
# Xcode's "Build the shell" phase: shell/out, the app's page, as the app ships
# it (npm run build:shell:release, see build-shell.ts at the repository's root).
#
# Xcode's environment describes the app (SDKROOT, deployment targets, ARCHS),
# but this builds the core and the CLI for this Mac, so it runs in a clean
# one. Only SHELL_PLUGINS and SHELL_FILES go through: set them on xcodebuild
# (`xcodebuild … SHELL_PLUGINS=<plugin>`) to build with other plugins.
set -e

cd "$(dirname "$0")/../.."

exec env -i \
    HOME="$HOME" USER="$USER" TMPDIR="$TMPDIR" \
    PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/local/go/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH" \
    ${SHELL_PLUGINS+"SHELL_PLUGINS=$SHELL_PLUGINS"} \
    ${SHELL_FILES+"SHELL_FILES=$SHELL_FILES"} \
    npm run build:shell:release
