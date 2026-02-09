const head = document.createElement("pre");
head.id = "head";
const headers = document.createElement("pre");
headers.id = "headers";
const body = document.createElement("pre");
body.id = "body";

document.body.append(head, headers, body);

const response = await fetch("http://localhost:9090", {
    method: "POST",
    body: new Uint8Array([1, 2, 3])
});
head.innerHTML = JSON.stringify(response, null, 2);
const headersObj = {};
response.headers.forEach((value, key) => (headersObj[key] = value));
headers.innerHTML = JSON.stringify(headersObj, null, 2);
const payload = await response.arrayBuffer();
body.innerHTML = `[ ${new Uint8Array(payload).join(", ")} ]`;

document.body.classList.add("done");

export {};
