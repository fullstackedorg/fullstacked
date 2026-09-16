#!/bin/sh

# go/clangwrap.sh

SDK="${SDK:-macosx}"

if [ "$SDK" = "macosx" ]; then
    unset IPHONEOS_DEPLOYMENT_TARGET
    export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-15.0}"
    MIN_VERSION_FLAG="-mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
elif [ "$SDK" = "iphoneos" ]; then
    unset MACOSX_DEPLOYMENT_TARGET
    export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-15.0}"
    MIN_VERSION_FLAG="-miphoneos-version-min=$IPHONEOS_DEPLOYMENT_TARGET"
fi

SDK_PATH=`xcrun --sdk $SDK --show-sdk-path`
CLANG=`xcrun --sdk $SDK --find clang`

if [ "$GOARCH" = "amd64" ]; then
    CARCH="x86_64"
elif [ "$GOARCH" = "arm64" ]; then
    CARCH="arm64"
fi

exec $CLANG ${CARCH:+-arch $CARCH} -isysroot "$SDK_PATH" $MIN_VERSION_FLAG "$@"