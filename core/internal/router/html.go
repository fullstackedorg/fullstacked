package router

import (
	"bytes"
	"fullstackedorg/fullstacked/internal/bundle"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/types"
	"path"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

var baseHTML = `<html>
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
	</head>
	<body></body>
</html>`

type DocumentHTML struct {
	root *html.Node
	head *html.Node
	body *html.Node
}

func (doc *DocumentHTML) addInHead(htmlStr string) error {
	fragment, err := html.Parse(strings.NewReader(string(htmlStr)))

	if err != nil {
		return err
	}

	doc.head.AppendChild(fragment)
	return nil
}

func (doc *DocumentHTML) addInBody(htmlStr string) error {
	fragment, err := html.Parse(strings.NewReader(string(htmlStr)))

	if err != nil {
		return err
	}

	doc.body.AppendChild(fragment)
	return nil
}

func newDoc() (DocumentHTML, error) {
	doc := DocumentHTML{}

	root, err := html.Parse(strings.NewReader(string(baseHTML)))

	if err != nil {
		return doc, err
	}

	doc.root = root

	for n := range root.Descendants() {
		if n.Type != html.ElementNode {
			continue
		}

		switch n.DataAtom {
		case atom.Head:
			doc.head = n
			continue
		case atom.Body:
			doc.body = n
			continue
		}
	}

	return doc, nil
}

func findMainScript(directory string) string {
	items, err := fs.ReadDirFn(directory)
	if err != nil {
		return ""
	}

	for _, ext := range bundle.BundleExtensions {
		for _, item := range items {
			if strings.HasSuffix(item.Name, "index"+ext) {
				return item.Name
			}
		}
	}

	return ""
}

func generateIndexHTML(ctx *types.Context, directory string) ([]byte, error) {
	doc, err := newDoc()

	if err != nil {
		return nil, err
	}

	mainScript := findMainScript(directory)

	if mainScript != "" {
		err = doc.addInBody("<script src=\"" + mainScript + "\" type=\"module\"></script>")

		bundledMainScript := resolveBundledJsFile(ctx, path.Join(directory, mainScript))
		bundledCss := bundledMainScript[0:len(bundledMainScript)-len(".js")] + ".css"

		if fs.ExistsFn(bundledCss) {
			doc.addInHead("<link rel=\"stylesheet\" href=\"" + path.Base(mainScript) + ".css\" />")
		}

		tailwindCss := bundledMainScript[0:len(bundledMainScript)-len(".js")] + ".tailwind.css"

		if fs.ExistsFn(tailwindCss) {
			doc.addInHead("<link rel=\"stylesheet\" href=\"" + path.Base(mainScript) + ".tailwind.css\" />")
		}
	}

	HTML := bytes.Buffer{}
	err = html.Render(&HTML, doc.root)

	if err != nil {
		return nil, err
	}

	return HTML.Bytes(), nil
}
