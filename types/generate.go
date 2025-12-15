package main

import (
	"fmt"
	"fullstackedorg/fullstacked/types"
	"os"
	"path"

	"github.com/gzuidhof/tygo/tygo"
)

var outDir = path.Join("..", "lib", "@types")

func main() {
	fmt.Println(types.UNDEFINED)

	os.RemoveAll(outDir)

	config := &tygo.Config{
		Packages: []*tygo.PackageConfig{
			{
				Path:       "fullstackedorg/fullstacked/types",
				OutputPath: "../lib/@types/index.ts",
			},
			{
				Path:       "fullstackedorg/fullstacked/internal/test",
				OutputPath: "../lib/@types/test.ts",
			},
			{
				Path:       "fullstackedorg/fullstacked/internal/fs",
				OutputPath: "../lib/@types/fs.ts",
			},
			{
				Path:       "fullstackedorg/fullstacked/internal/path",
				OutputPath: "../lib/@types/path.ts",
			},
		},
	}
	gen := tygo.New(config)
	fmt.Println(gen.Generate())
}
