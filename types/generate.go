package main

import (
	"fmt"
	"fullstackedorg/fullstacked/types"
	"os"
	"path"
	"strings"

	"github.com/gzuidhof/tygo/tygo"
)

var outDir = path.Join("..", "core", "internal", "bundle", "lib", "@types")

func main() {
	fmt.Println(types.UNDEFINED)

	os.RemoveAll(outDir)

	modules, _ := os.ReadDir("../core/internal")

	mainTypesPackage := tygo.PackageConfig{
		Path:       "fullstackedorg/fullstacked/types",
		OutputPath: path.Join(outDir, "index.ts"),
		EnumStyle:  "union",
	}

	packages := []*tygo.PackageConfig{&mainTypesPackage}
	for _, m := range modules {
		p := tygo.PackageConfig{
			Path:       "fullstackedorg/fullstacked/internal/" + m.Name(),
			OutputPath: path.Join(outDir, m.Name()+".ts"),
			EnumStyle:  "union",
		}
		packages = append(packages, &p)
	}

	config := &tygo.Config{
		Packages: packages,
		TypeMappings: map[string]string{
			"time.Time":   "number /* time.Time */",
			"os.FileMode": "number /* os.FileMode */",
			"[]byte":      "Uint8Array",
			"error":       "any",
		},
	}
	gen := tygo.New(config)
	err := gen.Generate()
	if err != nil {
		fmt.Println(err)
	}

	tsPath := path.Join(outDir, "index.ts")
	content, readErr := os.ReadFile(tsPath)
	if readErr == nil {
		newContent := strings.ReplaceAll(string(content), "Error: error;", "Error: any;")
		os.WriteFile(tsPath, []byte(newContent), 0644)
	}
}
