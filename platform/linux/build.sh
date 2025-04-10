rm -rf out

mkdir -p ./out/usr/share/fullstacked
cp -r ../../out/editor ./out/usr/share/fullstacked

mkdir ./out/DEBIAN
cp control out/DEBIAN/control

mkdir -p out/usr/bin
cp -r ../../core/bin .
g++ utils.cpp instance.cpp app.cpp main.cpp bin/linux-x86_64 -o out/usr/bin/fullstacked `pkg-config gtkmm-4.0 webkitgtk-6.0 --libs --cflags`