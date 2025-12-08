package main

import (
	"fmt"

	"github.com/gzuidhof/tygo/tygo"
)

func main() {
	config := &tygo.Config{
		Packages: []*tygo.PackageConfig{
			{
				Path:       "fullstackedorg/fullstacked/internal/router",
				OutputPath: "../lib/@types/router.ts",
			}, {
				Path:       "fullstackedorg/fullstacked/internal/fs",
				OutputPath: "../lib/@types/fs.ts",
			},
		},
	}
	gen := tygo.New(config)
	fmt.Println(gen.Generate())
}
