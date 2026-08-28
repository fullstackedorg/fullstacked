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

mkdir -p ./out/usr/share/fullstacked
if [ -d "../../app/out" ]; then
    cp -r ../../app/out ./out/usr/share/fullstacked/app
fi

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
