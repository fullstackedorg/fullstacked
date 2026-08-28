DEST=${1:-fullstacked.deb}
dpkg-deb --root-owner-group --build ./out "$DEST"