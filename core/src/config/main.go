package config

import (
	fs "fullstackedorg/fullstacked/src/fs"
	serialize "fullstackedorg/fullstacked/src/serialize"
	setup "fullstackedorg/fullstacked/src/setup"
	"path"
)

var fileEventOrigin = "config"

func Get(configFile string) ([]byte, error) {
	filePath := path.Join(setup.Directories.Config, configFile+".json")

	config, err := fs.ReadFile(filePath)

	if err != nil {
		return nil, err
	}

	return config, nil
}

func GetSerialized(configFile string) []byte {
	config, err := Get(configFile)

	if err != nil {
		return nil
	}

	return serialize.SerializeString(string(config))
}

func SaveSerialized(configFile string, data string) []byte {
	filePath := path.Join(setup.Directories.Config, configFile+".json")

	fs.Mkdir(path.Dir(filePath), fileEventOrigin)

	err := fs.WriteFile(filePath, []byte(data), fileEventOrigin)

	if err != nil {
		return serialize.SerializeBoolean(false)
	}

	return serialize.SerializeBoolean(true)
}
