package config

import (
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/types"
	"os"
	"path/filepath"
	"sync"
)

type ConfigFn = uint8

const (
	Get    ConfigFn = 0
	Set    ConfigFn = 1
	List   ConfigFn = 2
	Delete ConfigFn = 3
)

var configMutex sync.Mutex

func getConfigFilePath(ctx *types.Context) string {
	if ctx == nil {
		return ""
	}
	return filepath.Join(ctx.Directories.Root, ".git", "config.json")
}

func GetConfig(ctx *types.Context, key string) string {
	if ctx == nil {
		return ""
	}
	configMutex.Lock()
	defer configMutex.Unlock()

	conf, err := loadConfig(ctx)
	if err != nil {
		return ""
	}
	return conf[key]
}

func loadConfig(ctx *types.Context) (map[string]string, error) {
	configPath := getConfigFilePath(ctx)
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	if len(data) == 0 {
		return map[string]string{}, nil
	}
	var res map[string]string
	err = json.Unmarshal(data, &res)
	if err != nil {
		return map[string]string{}, nil
	}
	if res == nil {
		res = map[string]string{}
	}
	return res, nil
}

func saveConfig(ctx *types.Context, conf map[string]string) error {
	configPath := getConfigFilePath(ctx)
	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(conf, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(configPath, data, 0644)
}

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	configMutex.Lock()
	defer configMutex.Unlock()

	switch header.Fn {
	case Get:
		response.Type = types.CoreResponseData
		if len(data) == 0 || data[0].Data == nil {
			response.Data = nil
			return nil
		}
		key, ok := data[0].Data.(string)
		if !ok || key == "" {
			response.Data = nil
			return nil
		}
		conf, err := loadConfig(ctx)
		if err != nil {
			return err
		}
		val, exists := conf[key]
		if !exists {
			response.Data = nil
			return nil
		}
		response.Data = val
		return nil

	case Set:
		if len(data) == 0 || data[0].Data == nil {
			return errors.New("config set requires a key")
		}
		key, ok := data[0].Data.(string)
		if !ok || key == "" {
			return errors.New("config key must be a non-empty string")
		}

		if len(data) < 2 || data[1].Data == nil {
			return errors.New("config set requires a string value")
		}
		val, ok := data[1].Data.(string)
		if !ok {
			return errors.New("config value must be a string")
		}

		conf, err := loadConfig(ctx)
		if err != nil {
			return err
		}
		conf[key] = val
		if err := saveConfig(ctx, conf); err != nil {
			return err
		}
		response.Type = types.CoreResponseData
		response.Data = true
		return nil

	case List:
		conf, err := loadConfig(ctx)
		if err != nil {
			return err
		}
		response.Type = types.CoreResponseData
		response.Data = conf
		return nil

	case Delete:
		if len(data) == 0 || data[0].Data == nil {
			response.Type = types.CoreResponseData
			response.Data = true
			return nil
		}
		key, ok := data[0].Data.(string)
		if !ok || key == "" {
			response.Type = types.CoreResponseData
			response.Data = true
			return nil
		}

		conf, err := loadConfig(ctx)
		if err != nil {
			return err
		}
		delete(conf, key)
		if err := saveConfig(ctx, conf); err != nil {
			return err
		}
		response.Type = types.CoreResponseData
		response.Data = true
		return nil
	}

	return errors.New("unknown config function")
}
