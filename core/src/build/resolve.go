// https://nodejs.org/api/modules.html#all-together
package build

import (
	"encoding/json"
	fs "fullstackedorg/fullstacked/src/fs"
	setup "fullstackedorg/fullstacked/src/setup"
	"path"
	"strings"

	esbuild "github.com/evanw/esbuild/pkg/api"
)

func vResolve(projectDir string, resolveDir string, module string) *string {
	if strings.HasPrefix(module, "/") {
		panic("do not use absolute path for imports")
	}

	if strings.HasPrefix(module, ".") {
		modulePath := path.Clean(path.Join(resolveDir, module))
		resolvedPath := LOAD_AS_FILE(modulePath)
		if resolvedPath == nil {
			resolvedPath = LOAD_AS_DIR(modulePath)
		}
		if resolvedPath != nil {
			return resolvedPath
		}
	} else {
		exists := existResolve(module)
		if exists != nil {
			return exists
		}
	}

	// FullStacked lib modules
	resolvedPath := LOAD_FULLSTACKED_LIB_MODULE(module)
	if resolvedPath != nil {
		return resolvedPath
	}

	return LOAD_NODE_MODULES(projectDir, module)
}

var resolvingExtensions = []string{
	"", // if we have the extension in the modulePath
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".css",
}

func existResolve(filePath string) *string {
	for _, ext := range resolvingExtensions {
		filePathWithExt := filePath + ext
		exists, isFile := fs.Exists(filePathWithExt)
		if exists && isFile {
			return &filePathWithExt
		}
	}
	return nil
}

func LOAD_AS_FILE(modulePath string) *string {
	return existResolve(modulePath)
}

func LOAD_INDEX(dirPath string) *string {
	indexPath := path.Join(dirPath, "index")
	return existResolve(indexPath)
}

func LOAD_AS_DIR(modulePath string) *string {
	exists, isFile := fs.Exists(modulePath)
	if !exists || isFile {
		return nil
	}

	packageJsonPath := path.Join(modulePath, "package.json")
	pExists, _ := fs.Exists(packageJsonPath)
	if pExists {
		packageJsonData, _ := fs.ReadFile(packageJsonPath)
		packageJSON := PackageJSON{}
		err := json.Unmarshal(packageJsonData, &packageJSON)
		if err != nil {
			return LOAD_INDEX(modulePath)
		}

		if packageJSON.Module != "" {
			pModulePath := path.Join(modulePath, packageJSON.Module)

			moduleResolved := LOAD_AS_FILE(pModulePath)
			if moduleResolved != nil {
				return moduleResolved
			}
			moduleResolved = LOAD_INDEX(pModulePath)
			if moduleResolved != nil {
				return moduleResolved
			}
		}

		if packageJSON.Main != "" {
			mainPath := path.Join(modulePath, packageJSON.Main)

			mainResolved := LOAD_AS_FILE(mainPath)
			if mainResolved != nil {
				return mainResolved
			}
			mainResolved = LOAD_INDEX(mainPath)
			if mainResolved != nil {
				return mainResolved
			}
		}
	}

	return LOAD_INDEX(modulePath)
}

func LOAD_FULLSTACKED_LIB_MODULE(module string) *string {
	libModulePath := path.Join(setup.Directories.Editor, "fullstacked_modules", module)
	resolvedPath := LOAD_AS_FILE(libModulePath)
	if resolvedPath != nil {
		return resolvedPath
	}

	return LOAD_AS_DIR(libModulePath)
}

/*
*      name    modulePath
* |      ⌄       | ⌄ |
*  @scoped/package/file
 */
func ParseName(name string) (string, string) {
	scoped := strings.HasPrefix(name, "@")
	parts := strings.Split(name, "/")
	modulePath := ""

	if scoped {
		name = parts[0] + "/" + parts[1]
		if len(parts) > 2 {
			modulePath = "/" + strings.Join(parts[2:], "/")
		}
	} else {
		name = parts[0]
		if len(parts) > 1 {
			modulePath = "/" + strings.Join(parts[1:], "/")
		}
	}

	return name, modulePath
}

func LOAD_NODE_MODULES(projectDir string, module string) *string {
	name, modulePath := ParseName(module)

	packageDirectory := path.Join(projectDir, "node_modules", name)
	resolvedPath, packageJSON := LOAD_PACKAGE_EXPORTS(packageDirectory, modulePath)

	nodeModulePath := path.Join(packageDirectory, modulePath)
	if resolvedPath == nil {
		resolvedPath = LOAD_AS_FILE(nodeModulePath)
	}

	if resolvedPath == nil {
		resolvedPath = LOAD_AS_DIR(nodeModulePath)
	}

	if resolvedPath != nil && packageJSON != nil && packageJSON.Browser != nil {
		modulePath := "." + (*resolvedPath)[len(packageDirectory):]
		browserResolve := PACKAGE_BROWSER_RESOLVE(modulePath, packageJSON.Browser)
		if browserResolve != nil {
			browserResolveJoined := path.Join(packageDirectory, *browserResolve)
			resolvedPath = &browserResolveJoined
		}
	}

	return resolvedPath
}

type PackageJSON struct {
	Main             string            `json:"main"`
	Browser          json.RawMessage   `json:"browser"`
	Module           string            `json:"module"`
	Exports          json.RawMessage   `json:"exports"`
	Dependencies     map[string]string `json:"dependencies"`
	PeerDependencies map[string]string `json:"peerDependencies"`
}

func LOAD_PACKAGE_EXPORTS(packageDir string, modulePath string) (*string, *PackageJSON) {
	packageJsonPath := path.Join(packageDir, "package.json")
	exists, isFile := fs.Exists(packageJsonPath)
	if !exists || !isFile {
		return nil, nil
	}

	packageJsonData, _ := fs.ReadFile(packageJsonPath)
	packageJSON := PackageJSON{}
	err := json.Unmarshal(packageJsonData, &packageJSON)

	if err != nil || packageJSON.Exports == nil {
		return nil, &packageJSON
	}

	match := PACKAGE_EXPORTS_RESOLVE(packageDir, "."+modulePath, packageJSON.Exports)

	if match == nil {
		return nil, &packageJSON
	}

	return existResolve(*match), &packageJSON
}

// https://github.com/nodejs/node/blob/main/doc/api/esm.md
func PACKAGE_EXPORTS_RESOLVE(moduleDirectory string, subpath string, exports json.RawMessage) *string {
	//  "exports": "./index.js"
	exportsString := ""

	//  "exports": ["./index.js", "./module.js"]
	exportsStringArray := []string{}

	// "exports": {
	//     ".": {
	//         "react-server": "./react.shared-subset.js",
	//         "default": "./index.js"
	//     },
	//     "./submodule.js": "./src/submodule.js"
	// }
	exportsObject := (map[string]json.RawMessage)(nil)

	match := (*string)(nil)
	err := json.Unmarshal(exports, &exportsString)
	if err == nil {
		match = PACKAGE_EXPORTS_RESOLVE_STRING(moduleDirectory, subpath, exportsString)
	}

	if match == nil {
		err = json.Unmarshal(exports, &exportsStringArray)
		if err == nil {
			match = PACKAGE_EXPORTS_RESOLVE_STRING_ARRAY(moduleDirectory, subpath, exportsStringArray)
		}
	}

	if match == nil {
		err = json.Unmarshal(exports, &exportsObject)
		if err == nil {
			match = PACKAGE_EXPORTS_RESOLVE_OBJECT(moduleDirectory, subpath, exportsObject)
		}
	}

	return match
}

// "exports": "./index.js"
func PACKAGE_EXPORTS_RESOLVE_STRING(moduleDirectory string, subpath string, exports string) *string {
	modulePath := path.Join(moduleDirectory, exports)
	return &modulePath
}

// "exports": ["./index.js", "./module.js"]
func PACKAGE_EXPORTS_RESOLVE_STRING_ARRAY(moduleDirectory string, subpath string, exports []string) *string {
	for _, export := range exports {
		if strings.HasPrefix(export, subpath) {
			modulePath := path.Join(moduleDirectory, export)
			return &modulePath
		}
	}

	return nil
}

func removeExtension(filePath string) string {
	filePathComponents := strings.Split(filePath, ".")
	if len(filePathComponents) > 1 {
		filePathComponents = filePathComponents[:len(filePathComponents)-1]
	}

	return strings.Join(filePathComponents, ".")
}

func arrayEquals(arrA []string, arrB []string) bool {
	if len(arrA) != len(arrB) {
		return false
	}

	for i, v := range arrA {
		if v != arrB[i] {
			return false
		}
	}

	return true
}

//	"exports": {
//	    ".": {
//	        "react-server": "./react.shared-subset.js",
//	        "default": "./index.js"
//	   },
//	   "./package.json": "./package.json",
//	   "./jsx-runtime": "./jsx-runtime.js",
//	   "./jsx-dev-runtime": "./jsx-dev-runtime.js"
//	}
//
//	"exports": {
//		  "types": "./types/index.d.ts",
//		  "node": {
//		  	  "require": "./sass.node.js",
//		  	  "default": "./sass.node.mjs"
//		  },
//		  "default": {
//		  	  "require": "./sass.default.cjs",
//		  	  "default": "./sass.default.js"   <= this is the one we want
//		  }
//	}
func PACKAGE_EXPORTS_RESOLVE_OBJECT(moduleDirectory string, subpath string, exports map[string]json.RawMessage) *string {
	if subpath == "." && exports["default"] != nil {
		return PACKAGE_EXPORTS_RESOLVE(moduleDirectory, ".", exports["default"])
	}

	if subpath == "./" {
		subpath = "."
	}

	for key, export := range exports {
		if key == subpath {
			exportString := ""
			err := json.Unmarshal(export, &exportString)
			if err == nil {
				return PACKAGE_EXPORTS_RESOLVE_STRING(moduleDirectory, subpath, exportString)
			}

			exportStringArray := []string{}
			err = json.Unmarshal(export, &exportStringArray)
			if err == nil {
				return PACKAGE_EXPORTS_RESOLVE_STRING_ARRAY(moduleDirectory, subpath, exportStringArray)
			}

			exportObject := (map[string]string)(nil)
			err = json.Unmarshal(export, &exportObject)
			if err == nil {
				exportDefault := exportObject["default"]
				if exportDefault == "" {
					exportDefault = exportObject["import"]
				}
				return PACKAGE_EXPORTS_RESOLVE_STRING(moduleDirectory, subpath, exportDefault)
			}
		}

		if !strings.HasSuffix(key, "*") {
			continue
		}

		keyNoExt := removeExtension(key)
		keyNoExtComponents := strings.Split(keyNoExt, "/")

		subpathComponents := strings.Split(subpath, "/")

		if !arrayEquals(keyNoExtComponents[:len(keyNoExtComponents)-1], subpathComponents[:len(subpathComponents)-1]) {
			continue
		}

		matchString := (*string)(nil)

		exportString := (*string)(nil)
		err := json.Unmarshal(export, exportString)
		if err == nil {
			matchString = exportString
		}

		if matchString == nil {
			exportObject := (map[string]string)(nil)
			err = json.Unmarshal(export, &exportObject)
			if err == nil {
				exportDefault := exportObject["default"]
				if exportDefault == "" {
					exportDefault = exportObject["import"]
				}
				matchString = &exportDefault
			}
		}

		if matchString == nil {
			continue
		}

		exportComponents := strings.Split(*matchString, "/")

		resolvedComponents := exportComponents[:len(exportComponents)-1]
		resolvedComponents = append(resolvedComponents, subpathComponents[len(subpathComponents)-1])
		resolvedPath := strings.Join(resolvedComponents, "/")
		modulePath := path.Join(moduleDirectory, resolvedPath)
		return &modulePath
	}

	return nil
}

func PACKAGE_BROWSER_RESOLVE(path string, browser json.RawMessage) *string {
	if path == "." {
		browserString := ""
		err := json.Unmarshal(browser, &browserString)
		if err == nil {
			return &browserString
		}
	}

	browserObject := (map[string]string)(nil)
	err := json.Unmarshal(browser, &browserObject)
	if err != nil {
		return nil
	}

	for key, modulePath := range browserObject {
		if key == path {
			return &modulePath
		}
	}

	return nil
}

func inferLoader(filePath string) esbuild.Loader {
	pathComponents := strings.Split(filePath, ".")
	ext := pathComponents[len(pathComponents)-1]

	switch ext {
	case "json":
		return esbuild.LoaderJSON
	case "ts":
		return esbuild.LoaderTS
	case "tsx":
		return esbuild.LoaderTSX
	case "js", "mjs", "cjs":
		return esbuild.LoaderJS
	case "jsx":
		return esbuild.LoaderJSX
	case "css":
		return esbuild.LoaderCSS
	}

	return esbuild.LoaderFile
}
