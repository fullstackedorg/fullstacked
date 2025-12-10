package router

import "fullstackedorg/fullstacked/internal/fs"

type Module = int

const (
	Fs   Module = 0
	Path Module = 1
	Os   Module = 2
	Net  Module = 3
)

type CoreResponseType = int

const (
	CoreError  CoreResponseType = 0
	CoreData   CoreResponseType = 1
	CoreStream CoreResponseType = 2
)

func Call(module Module, fn int, payload []byte) []byte {
	switch module {
	case Fs:
		fs.Switch(fn, payload)
	case Path:
	}
}
