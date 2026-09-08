package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"fullstackedorg/fullstacked/types"
	"os"
	"path/filepath"
)

type ConfigFn = uint8

const (
	Get    ConfigFn = 0
	Set    ConfigFn = 1
	Delete ConfigFn = 2
	Load   ConfigFn = 3
)

func configFilePath(ctx *types.Context) string {
	return filepath.Join(ctx.Directories.Root, ".git", "config.json")
}

func loadConfigFile(ctx *types.Context) map[string]any {
	cfgPath := configFilePath(ctx)
	content, err := os.ReadFile(cfgPath)
	if err != nil {
		return make(map[string]any)
	}
	var conf map[string]any
	if err := json.Unmarshal(content, &conf); err != nil {
		return make(map[string]any)
	}
	if conf == nil {
		return make(map[string]any)
	}
	return conf
}

func saveConfigFile(ctx *types.Context, conf map[string]any) error {
	cfgPath := configFilePath(ctx)
	gitDir := filepath.Dir(cfgPath)
	if err := os.MkdirAll(gitDir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(conf, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(cfgPath, data, 0644)
}

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case Get:
		response.Type = types.CoreResponseData
		conf := loadConfigFile(ctx)
		key := ""
		if len(data) > 0 && data[0].Data != nil {
			if s, ok := data[0].Data.(string); ok {
				key = s
			}
		}
		if key == "" {
			response.Data = conf
			return nil
		}
		if val, ok := conf[key]; ok {
			switch v := val.(type) {
			case string:
				response.Data = v
			default:
				response.Data = fmt.Sprintf("%v", v)
			}
			return nil
		}
		response.Data = nil
		return nil

	case Set:
		response.Type = types.CoreResponseData
		if len(data) < 2 {
			return errors.New("config.Set requires key and value")
		}
		key, ok := data[0].Data.(string)
		if !ok {
			return errors.New("config.Set key must be string")
		}
		var val string
		switch v := data[1].Data.(type) {
		case string:
			val = v
		default:
			val = fmt.Sprintf("%v", v)
		}
		conf := loadConfigFile(ctx)
		conf[key] = val
		if err := saveConfigFile(ctx, conf); err != nil {
			return err
		}
		response.Data = nil
		return nil

	case Delete:
		response.Type = types.CoreResponseData
		if len(data) < 1 {
			return errors.New("config.Delete requires key")
		}
		key, ok := data[0].Data.(string)
		if !ok {
			return errors.New("config.Delete key must be string")
		}
		conf := loadConfigFile(ctx)
		delete(conf, key)
		if err := saveConfigFile(ctx, conf); err != nil {
			return err
		}
		response.Data = nil
		return nil

	case Load:
		response.Type = types.CoreResponseData
		conf := loadConfigFile(ctx)
		response.Data = conf
		return nil
	}

	return errors.New("unknown config function")
}
