package build

import (
	"bytes"
	"fmt"
	fs "fullstackedorg/fullstacked/src/fs"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

func SetupHTML(htmlFilePath string) []byte {
	indexFileExists, isFile := fs.Exists(htmlFilePath)

	if !indexFileExists || !isFile {
		return DefaultHTML
	}

	htmlContent, err := fs.ReadFile(htmlFilePath)

	if err != nil {
		fmt.Println(err)
		return DefaultHTML
	}

	htmlContent, err = injectScriptInHTML(htmlContent)

	// in case of errors, should return
	// non-injected html content and alert user
	if err != nil {
		fmt.Println(err)
		return DefaultHTML
	}

	return htmlContent
}

type DefaultHTMLElement struct {
	Text   string
	InHead bool
	Atom   atom.Atom
	Attr   map[string][]string
}

var defaultHTMLElements = []DefaultHTMLElement{
	{
		Text:   `<meta charset="utf-8" />`,
		InHead: true,
		Atom:   atom.Meta,
		Attr:   map[string][]string{"charset": {"*"}},
	},
	{
		Text:   `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />`,
		InHead: true,
		Atom:   atom.Meta,
		Attr:   map[string][]string{"name": {"viewport"}},
	},
	{
		Text:   `<link rel="stylesheet" href="/index.css" />`,
		InHead: true,
		Atom:   atom.Link,
		Attr: map[string][]string{
			"rel":  {"stylesheet"},
			"href": {"index.css", "/index.css"},
		},
	},
	{
		Text:   `<link rel="stylesheet" href="/style.css" />`,
		InHead: true,
		Atom:   atom.Link,
		Attr: map[string][]string{
			"rel":  {"stylesheet"},
			"href": {"style.css", "/style.css"},
		},
	},
	{
		Text: `<script type="module" src="/index.js"></script>`,
		Atom: atom.Script,
		Attr: map[string][]string{
			"type": {"module"},
			"src":  {"index.js", "/index.js"},
		},
	},
}

var DefaultHTML = []byte(`<html>
	<head>` +
	defaultHTMLElements[0].Text +
	defaultHTMLElements[1].Text +
	defaultHTMLElements[2].Text +
	`</head>
	<body>` +
	defaultHTMLElements[3].Text +
	`</body>
</html>`)

func getDefaultElementNode(e DefaultHTMLElement) *html.Node {
	doc, _ := html.Parse(strings.NewReader(e.Text))

	for n := range doc.Descendants() {
		if n.Type == html.ElementNode && n.DataAtom == e.Atom {
			n.Parent.RemoveChild(n)
			return n
		}
	}

	return nil
}

func injectScriptInHTML(htmlContent []byte) ([]byte, error) {
	doc, err := html.Parse(strings.NewReader(string(htmlContent)))

	if err != nil {
		return nil, err
	}

	injectDefaultTagsInDoc(doc)

	HTML := bytes.Buffer{}
	err = html.Render(&HTML, doc)

	if err != nil {
		return nil, err
	}

	return HTML.Bytes(), nil
}

func allTrue(arr []bool) bool {
	for _, b := range arr {
		if !b {
			return false
		}
	}
	return true
}

func attrMatch(key string, values []string, attrs []html.Attribute) bool {
	for _, attr := range attrs {
		if attr.Key != key {
			continue
		}

		for _, v := range values {
			if v == attr.Val {
				return true
			}
		}
	}

	return false
}

func injectDefaultTagsInDoc(doc *html.Node) {
	hasDefaultHTMLElement := make([]bool, len(defaultHTMLElements))

	head := (*html.Node)(nil)
	body := (*html.Node)(nil)

	for n := range doc.Descendants() {
		if n.Type != html.ElementNode {
			continue
		}

		switch n.DataAtom {
		case atom.Head:
			head = n
			continue
		case atom.Body:
			body = n
			continue
		}

		for i, defaultElement := range defaultHTMLElements {
			if defaultElement.Atom != n.DataAtom {
				continue
			}

			hasAttr := make([]bool, len(defaultElement.Attr))
			j := 0
			for attr, values := range defaultElement.Attr {
				hasAttr[j] = attrMatch(attr, values, n.Attr)
				j++
			}

			if allTrue(hasAttr) {
				hasDefaultHTMLElement[i] = true
			}
		}
	}

	if allTrue(hasDefaultHTMLElement) {
		return
	}

	for i := range hasDefaultHTMLElement {
		if hasDefaultHTMLElement[i] {
			continue
		}

		defaultHTMLElement := defaultHTMLElements[i]

		n := getDefaultElementNode(defaultHTMLElement)

		if defaultHTMLElement.InHead {
			head.AppendChild(n)
		} else {
			body.AppendChild(n)
		}
	}
}
