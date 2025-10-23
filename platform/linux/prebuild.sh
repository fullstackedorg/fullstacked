rm -rf out

mkdir -p out/usr/bin
cp -r ../../core/bin .

cp -f bin/linux-$1.h bin/linux.h

mkdir -p ./out/usr/share/fullstacked
cp -r ../../out/build ./out/usr/share/fullstacked/editor

FRAMEWORK=$2

mkdir ./out/DEBIAN
cp control-$FRAMEWORK out/DEBIAN/control

ARCH=$1

if [ "$ARCH" = "x64" ]; then
    ARCH="amd64"
fi

sed -i "s/Architecture:/Architecture: $ARCH/g" out/DEBIAN/control
