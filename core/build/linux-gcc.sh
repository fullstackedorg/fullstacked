#!/bin/sh

if [ "$GOARCH" == "amd64" ]; then
    CC="x86_64-linux-gnu-gcc"
elif [ "$GOARCH" == "arm64" ]; then
    CC="aarch64-linux-gnu-gcc"
fi

exec $CC "$@"