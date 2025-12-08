package router

import "fullstackedorg/fullstacked/internal/fs"

type Module = int

const (
	Fs   Module = 0
	Path Module = 1
	Os   Module = 2
	Net  Module = 3
)

func Call(module Module, fn int, payload []byte) []byte {
	switch module {
	case Fs:
		fs.Switch(fn, payload)
	case Path:
	}
}
