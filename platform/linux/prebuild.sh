rm -rf out

mkdir -p out/usr/bin
cp -r ../../core/bin .

ARCH=$1
if [ -z "$ARCH" ]; then
    UNAME_M=$(uname -m)
    if [ "$UNAME_M" = "x86_64" ]; then
        ARCH="x64"
    else
        ARCH="arm64"
    fi
fi

if [ -f "bin/linux-$ARCH.h" ]; then
    cp -f bin/linux-$ARCH.h bin/linux.h
fi

# the app's page: shell/out as the app ships it (build-shell.ts at the
# repository's root). SHELL_PLUGINS and SHELL_FILES in the environment change
# its plugins and extra files.
(cd ../.. && npm run build:shell:release) || exit 1

mkdir -p ./out/usr/share/fullstacked
cp -r ../../shell/out ./out/usr/share/fullstacked/app

mkdir -p ./out/usr/share/applications ./out/usr/share/icons
cp org.fullstacked.desktop ./out/usr/share/applications/
cp -r icons/hicolor ./out/usr/share/icons/

FRAMEWORK=$2
if [ -n "$FRAMEWORK" ] && [ -f "control-$FRAMEWORK" ]; then
    mkdir -p ./out/DEBIAN
    cp control-$FRAMEWORK out/DEBIAN/control

    DEB_ARCH=$ARCH
    if [ "$DEB_ARCH" = "x64" ]; then
        DEB_ARCH="amd64"
    fi

    sed -i "s/Architecture:.*/Architecture: $DEB_ARCH/g" out/DEBIAN/control
fi
