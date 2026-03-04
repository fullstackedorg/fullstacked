package bundle

import (
	"bytes"
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
	fragment, err := html.ParseFragment(strings.NewReader(string(htmlStr)), doc.head)

	if err != nil {
		return err
	}

	for _, node := range fragment {
		doc.head.AppendChild(node)
	}
	return nil
}

func (doc *DocumentHTML) addInBody(htmlStr string) error {
	fragment, err := html.ParseFragment(strings.NewReader(string(htmlStr)), doc.body)

	if err != nil {
		return err
	}

	for _, node := range fragment {
		doc.body.AppendChild(node)
	}
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

func generateIndexHTML(files []string) ([]byte, error) {
	doc, err := newDoc()

	if err != nil {
		return nil, err
	}

	for _, file := range files {
		ext := path.Ext(file)

		switch ext {
		case ".js":
			err = doc.addInBody("<script src=\"" + file + "\" type=\"module\"></script>")
		case ".css":
			err = doc.addInHead("<link rel=\"stylesheet\" href=\"" + file + "\" />")
		}
	}

	HTML := bytes.Buffer{}
	err = html.Render(&HTML, doc.root)

	if err != nil {
		return nil, err
	}

	return HTML.Bytes(), nil
}
