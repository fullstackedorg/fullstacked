//go:build NO_TSGO
// +build NO_TSGO

package methods

var TSGOptr = (*tsgo)(nil)

func (t *tsgo) start(directory string) string {
	return ""
}
func (t *tsgo) request(transportId string, message string) {
}
func (t *tsgo) end(transportId string) {
}
func (t *tsgo) version() string {
	return ""
}
