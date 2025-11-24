//go:build !NO_TSGO
// +build !NO_TSGO

package methods

import (
	ts_lsp "fullstackedorg/fullstacked/src/lsp"
)

var TSGO = tsgo{}
var TSGOptr = &TSGO

func (t *tsgo) start(directory string) string {
	return ts_lsp.Start(directory)
}
func (t *tsgo) request(transportId string, message string) {
	ts_lsp.Request(transportId, message)
}
func (t *tsgo) end(transportId string) {
	ts_lsp.End(transportId)
}
func (t *tsgo) version() string {
	return ts_lsp.Version()
}
