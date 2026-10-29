// DOMPurify as packages use it, on the DOM of lib/DOMParser (workers and
// fullstacked --file) and on the browser's: the same inputs and options
// must give the same output, and no output may carry script.
//
// sanitizeAll and unsafeParts use nothing but their arguments: their
// source is also run in the browser (test/shim/DOMParser).

export type PurifyCase = {
    name: string;
    dirty: string;
    config?: Record<string, unknown>;
    // "new tab": the afterSanitizeAttributes hook of the README that opens
    // links in a new tab
    hook?: "new tab";
};

// markup an app sanitizes (rendered Markdown, rich text, comments)
export const COMMON: PurifyCase[] = [
    { name: "text only", dirty: "just text" },
    { name: "empty", dirty: "" },
    { name: "leading whitespace", dirty: "  \n <b>x</b>" },
    {
        name: "paragraphs and inline",
        dirty: `<p>Hello <b>world</b> &amp; <i>friends</i>, <em>em</em> <strong>strong</strong> <u>u</u> <s>s</s> <sub>1</sub><sup>2</sup></p>`
    },
    {
        name: "headings and lists",
        dirty: `<h1>Title</h1><h2>Sub</h2><ul><li>one<li>two</ul><ol start=3><li>three</li></ol>`
    },
    {
        name: "links",
        dirty: `<a href="https://example.com/?q=1&x=2" title="t">abs</a> <a href="/rel">rel</a> <a href="#frag">frag</a> <a href="mailto:a@b.c">mail</a>`
    },
    {
        name: "images",
        dirty: `<img src="a.png" alt="A" width=10 height="20"><img src="data:image/png;base64,iVBORw0KGgo=">`
    },
    {
        name: "table",
        dirty: `<table><thead><tr><th>h</th></tr></thead><tbody><tr><td colspan=2>1</td></tr></tbody></table>`
    },
    {
        name: "code",
        dirty: `<pre><code class="language-js">if (a &lt; b) { return "&amp;"; }</code></pre><p>inline <code>x</code></p>`
    },
    {
        name: "blocks",
        dirty: `<blockquote>q</blockquote><hr><br><div><span>s</span></div><details><summary>s</summary>d</details>`
    },
    {
        name: "global attributes",
        dirty: `<div style="color:red" class="x y" id="main" data-x="1" aria-label="l" title="t" dir="rtl" lang="en">styled</div>`
    },
    {
        name: "entities and quotes",
        dirty: `<span title='a "b" &amp; c'>&nbsp;&lt;&gt;&quot;"' &copy; caf&eacute;</span>`
    },
    {
        name: "svg",
        dirty: `<svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/><path d="M0 0L10 10"/></svg>`
    },
    {
        name: "forms",
        dirty: `<form action="/x"><label for=a>A</label><input id=a name=a type=checkbox checked disabled><select><option value=1 selected>One</option></select><textarea>t</textarea><button>b</button></form>`
    },
    { name: "comment dropped", dirty: `<!-- comment --><p>x</p>` },
    { name: "unclosed", dirty: `<p>unclosed <span>s<p>next<li>item` },
    {
        name: "unknown element",
        dirty: `<custom-tag a=1>kept text</custom-tag>`
    },
    {
        name: "profile html",
        dirty: `<p>x</p><svg><circle r=1 /></svg><math><mi>x</mi></math>`,
        config: { USE_PROFILES: { html: true } }
    },
    {
        name: "allowed tags and attributes",
        dirty: `<p class=c><b>b</b> <i>i</i> <a href="/x" title=t>a</a> <u>u</u></p>`,
        config: { ALLOWED_TAGS: ["b", "i", "a"], ALLOWED_ATTR: ["href"] }
    },
    {
        name: "forbidden tags and attributes",
        dirty: `<p style="x">p</p><style>a{}</style><b class=c>b</b>`,
        config: { FORBID_TAGS: ["b"], FORBID_ATTR: ["style"] }
    },
    {
        name: "keep content off",
        dirty: `<p>a<custom>b</custom>c</p>`,
        config: { KEEP_CONTENT: false }
    },
    {
        name: "add attributes",
        dirty: `<a href="/x" target="_blank">x</a>`,
        config: { ADD_ATTR: ["target"] }
    },
    {
        name: "whole document",
        dirty: `<html><head><title>t</title></head><body><p>x</p></body></html>`,
        config: { WHOLE_DOCUMENT: true }
    },
    {
        name: "dom fragment",
        dirty: `<p>a</p>b<i>c</i><script>x</script>`,
        config: { RETURN_DOM_FRAGMENT: true }
    },
    {
        name: "safe for templates",
        dirty: `<p>{{ secret }} <b>\${x}</b> <%= y %></p>`,
        config: { SAFE_FOR_TEMPLATES: true }
    },
    {
        name: "hook: links in a new tab",
        dirty: `<a href="https://example.com">x</a> <b>y</b>`,
        hook: "new tab"
    }
];

// what DOMPurify exists for: none of it may come out
export const PAYLOADS: PurifyCase[] = [
    { name: "script", dirty: `<b>a</b><script>alert(1)</script>` },
    { name: "img onerror", dirty: `<img src=x onerror=alert(1)>` },
    { name: "javascript href", dirty: `<a href="javascript:alert(1)">x</a>` },
    {
        name: "obfuscated javascript href",
        dirty: `<a href="  JaVaScRiPt:alert(1)">x</a><a href="java&#x09;script:alert(1)">y</a>`
    },
    {
        name: "data html href",
        dirty: `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">d</a>`
    },
    { name: "iframe", dirty: `<iframe src="javascript:alert(1)"></iframe>` },
    {
        name: "iframe srcdoc",
        dirty: `<iframe srcdoc="<script>alert(1)</script>">`
    },
    { name: "object", dirty: `<object data="javascript:alert(1)"></object>` },
    { name: "embed", dirty: `<embed src="javascript:alert(1)">` },
    { name: "svg onload", dirty: `<svg onload=alert(1)><g/></svg>` },
    { name: "svg script", dirty: `<svg><script>alert(1)</script></svg>` },
    {
        name: "svg animate href",
        dirty: `<svg><a><animate attributeName=href values=javascript:alert(1) /><text y=10>x</text></a></svg>`
    },
    {
        name: "math xlink",
        dirty: `<math><mi xlink:href="javascript:alert(1)">x</mi></math>`
    },
    { name: "event handler", dirty: `<div onclick="alert(1)">c</div>` },
    { name: "autofocus", dirty: `<input onfocus=alert(1) autofocus>` },
    {
        name: "unknown element handler",
        dirty: `<x onmouseover=alert(1)>hover</x>`
    },
    { name: "style element", dirty: `<style>@import "x"</style><p>y</p>` },
    { name: "base", dirty: `<base href="javascript:/"><a href="x">a</a>` },
    {
        name: "meta refresh",
        dirty: `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`
    },
    {
        name: "template",
        dirty: `<template><script>alert(1)</script><img src=x onerror=alert(1)></template>`
    },
    {
        name: "noscript attribute",
        dirty: `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`
    },
    {
        name: "mxss math style",
        dirty: `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`
    },
    {
        name: "mxss form",
        dirty: `<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>`
    },
    {
        name: "comment breakout",
        dirty: `<!--<img src=x onerror=alert(1)>--><p>x</p>`
    },
    {
        name: "dom clobbering",
        dirty: `<img name="getElementById"><form id="x"><input name="attributes"></form>`
    }
];

export function sanitizeAll(DOMPurify: any, cases: PurifyCase[]) {
    const out: Record<string, string> = {};
    for (const c of cases) {
        try {
            if (c.hook === "new tab") {
                DOMPurify.addHook("afterSanitizeAttributes", (node: any) => {
                    if (node.nodeName === "A") {
                        node.setAttribute("target", "_blank");
                        node.setAttribute("rel", "noopener noreferrer");
                    }
                });
            }
            const config = c.config ?? {};
            const result = DOMPurify.sanitize(c.dirty, config);
            out[c.name] = config.RETURN_DOM_FRAGMENT
                ? Array.from(result.childNodes as ArrayLike<any>)
                      .map((n) =>
                          n.nodeType === 1 ? n.outerHTML : n.textContent
                      )
                      .join("")
                : String(result);
        } catch (e) {
            out[c.name] = `threw ${(e as Error).name}: ${(e as Error).message}`;
        } finally {
            DOMPurify.removeAllHooks();
        }
    }
    return out;
}

// what of html could run script once in a page: script-bearing elements,
// event handler attributes, javascript: and data:text/html URLs
export function unsafeParts(html: string, DOMParser: any): string[] {
    const doc = new DOMParser().parseFromString(
        "<!DOCTYPE html><body>" + html,
        "text/html"
    );
    const found: string[] = [];
    const walk = (node: any) => {
        for (const child of Array.from(node.childNodes as ArrayLike<any>)) {
            if (child.nodeType !== 1) continue;
            const name = String(child.localName).toLowerCase();
            if (
                [
                    "script",
                    "iframe",
                    "object",
                    "embed",
                    "base",
                    "meta",
                    "frame",
                    "frameset",
                    "applet"
                ].includes(name)
            ) {
                found.push(name);
            }
            for (const attr of Array.from(child.attributes as ArrayLike<any>)) {
                const attrName = String(attr.name).toLowerCase();
                const value = String(attr.value)
                    .replace(/[\u0000- ]/g, "")
                    .toLowerCase();
                if (attrName.startsWith("on"))
                    found.push(`${name}@${attrName}`);
                if (
                    /^(javascript|vbscript):/.test(value) ||
                    value.startsWith("data:text/html")
                ) {
                    found.push(`${name}@${attrName}=${value.slice(0, 20)}`);
                }
            }
            walk(child);
            if (child.content) walk(child.content);
        }
    };
    walk(doc);
    return found;
}
