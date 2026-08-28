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

g++ -std=c++20 -DGTK=1 \
    $(pkg-config gtkmm-4.0 webkitgtk-6.0 --cflags) \
    src/utils.cpp \
    src/core.cpp \
    src/gtk/gtk.cpp \
    src/app.cpp \
    src/main.cpp \
    src/base64.cpp \
    bin/linux-$ARCH.a \
    $(pkg-config gtkmm-4.0 webkitgtk-6.0 --libs) \
    -lpthread -ldl \
    -o out/usr/bin/fullstacked