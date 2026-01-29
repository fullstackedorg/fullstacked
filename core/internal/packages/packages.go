package packages

import (
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/types"
)

type PackagesFn = uint8

const (
	Install   PackagesFn = 0
	Uninstall PackagesFn = 1
)

func Switch(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	}

	return errors.New("unknown packages function")
}

type PackageJSON struct {
	Name            string            `json:"name"`
	Version         string            `json:"version"`
	Dependencies    map[string]string `json:"dependencies"`
	DevDependencies map[string]string `json:"devDependencies"`

	Main    string          `json:"main"`
	Browser json.RawMessage `json:"browser"`
	Module  string          `json:"module"`
	Exports json.RawMessage `json:"exports"`
}

func install(directory string, packagesName []string, devDependencies bool) {

}
