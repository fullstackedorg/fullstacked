#!/bin/bash
set -e

# ./build-gtk.sh [ arm64 | x64 ]
ARCH=$1
if [ -z "$ARCH" ]; then
    UNAME_M=$(uname -m)
    if [ "$UNAME_M" = "x86_64" ]; then
        ARCH="x64"
    else
        ARCH="arm64"
    fi
fi

sh ./prebuild.sh $ARCH gtk

CXX="g++"
PKG_CONFIG="pkg-config"

if [ "$ARCH" = "x64" ] && [ "$(uname -m)" != "x86_64" ]; then
    CXX="x86_64-linux-gnu-g++"
    if command -v x86_64-linux-gnu-pkg-config >/dev/null 2>&1; then
        PKG_CONFIG="x86_64-linux-gnu-pkg-config"
    else
        export PKG_CONFIG_LIBDIR="/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig"
    fi
elif [ "$ARCH" = "arm64" ] && [ "$(uname -m)" = "x86_64" ]; then
    CXX="aarch64-linux-gnu-g++"
    if command -v aarch64-linux-gnu-pkg-config >/dev/null 2>&1; then
        PKG_CONFIG="aarch64-linux-gnu-pkg-config"
    else
        export PKG_CONFIG_LIBDIR="/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig"
    fi
fi

$CXX -std=c++20 -DGTK=1 \
    $($PKG_CONFIG gtkmm-4.0 webkitgtk-6.0 --cflags) \
    src/utils.cpp \
    src/core.cpp \
    src/gtk/gtk.cpp \
    src/app.cpp \
    src/main.cpp \
    src/base64.cpp \
    bin/linux-$ARCH.a \
    $($PKG_CONFIG gtkmm-4.0 webkitgtk-6.0 --libs) \
    -lpthread -ldl \
    -o out/usr/bin/fullstacked