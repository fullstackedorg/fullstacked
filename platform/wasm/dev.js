import http from "http";
import fs from "fs";
import open from "open";
import mimeTypes from "mime-types";

const notFound = {
    code: 404,
    headers: {
        "content-type": "text/html"
    },
    body: "Not Found"
};

const existsAndIsFile = (pathname) => {
    let stat;
    try {
        stat = fs.statSync(pathname);
    } catch (e) {
        return false;
    }

    return stat.isFile();
};

const hanlder = (req, res) => {
    let pathname = req.url.split("?").shift();

    if (pathname.startsWith("/")) pathname = pathname.slice(1);
    if (pathname.endsWith("/")) pathname = pathname.slice(0, -1);

    const basedir = "out" + (pathname.startsWith("bin") ? "" : "/site");

    pathname = basedir + "/" + pathname;

    if (!existsAndIsFile(pathname)) {
        const maybeIndex = pathname + (pathname ? "/" : "") + "index.html";
        if (existsAndIsFile(maybeIndex)) pathname = maybeIndex;
    }

    let stats;

    try {
        stats = fs.statSync(pathname);
    } catch (e) { }

    if (!stats || stats.isDirectory()) {
        res.writeHead(notFound.code, notFound.headers);
        res.end(notFound.body);
        return;
    }

    const readStream = fs.createReadStream(pathname);
    res.writeHead(200, {
        "content-type": mimeTypes.lookup(pathname),
        "content-length": stats.size
    });
    readStream.pipe(res);
};

http.createServer(hanlder).listen(9000, "0.0.0.0");
open("http://localhost:9000");
