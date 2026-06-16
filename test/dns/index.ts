import test, { suite } from "node:test";
import assert from "node:assert";
import * as dns from "../../core/internal/bundle/lib/dns/index.ts";
import * as nodeDns from "node:dns";

nodeDns.setServers(["8.8.8.8:53"]);

suite("dns - e2e", () => {
    test("resolve4", async () => {
        const host = "testa.fullstacked.org";
        const nodeIPs = await nodeDns.promises.resolve4(host);
        const IPs = await dns.promises.resolve4(host);
        assert.deepEqual(nodeIPs, IPs);
    });
    test("resolve6", async () => {
        const host = "testaaaa.fullstacked.org";
        const nodeIPs = await nodeDns.promises.resolve6(host);
        const IPs = await dns.promises.resolve6(host);
        assert.deepEqual(nodeIPs, IPs);
    });
    test("resolveCname", async () => {
        const host = "testcname.fullstacked.org";
        const nodeCname = await nodeDns.promises.resolveCname(host);
        const cname = await dns.promises.resolveCname(host);
        assert.deepEqual(nodeCname, cname);
    });
    test("resolveMx", async () => {
        const host = "testmx.fullstacked.org";
        const nodeMx = await nodeDns.promises.resolveMx(host);
        const mx = await dns.promises.resolveMx(host);
        assert.deepEqual(nodeMx, mx);
    });
    test("resolveNs", async () => {
        const host = "fullstacked.org";
        const nodeMx = await nodeDns.promises.resolveNs(host);
        const mx = await dns.promises.resolveNs(host);
        assert.deepEqual(nodeMx.sort(), mx.sort());
    });
    test("resolveSrv", async () => {
        const host = "testsrv.fullstacked.org";
        const nodeSrv = await nodeDns.promises.resolveSrv(host);
        const srv = await dns.promises.resolveSrv(host);
        assert.deepEqual(nodeSrv, srv);
    });
    test("resolveTxt", async () => {
        const host = "testtxt.fullstacked.org";
        const nodeTxt = await nodeDns.promises.resolveTxt(host);
        const txt = await dns.promises.resolveTxt(host);
        assert.deepEqual(nodeTxt, txt);
    });
    test("lookup callback (all)", async () => {
        const host = "testa.fullstacked.org";
        const nodeLookup = await new Promise((res, rej) =>
            nodeDns.lookup(host, { all: true }, (err, addresses) =>
                err ? rej(err) : res(addresses)
            )
        );
        const lookup = await new Promise((res, rej) =>
            dns.lookup(host, { all: true }, (err: any, addresses: any) =>
                err ? rej(err) : res(addresses)
            )
        );
        assert.deepEqual(nodeLookup, lookup);
    });
    test("lookup callback (single)", async () => {
        const host = "testa.fullstacked.org";
        const nodeLookup = await new Promise((res, rej) =>
            nodeDns.lookup(host, (err, address, family) =>
                err ? rej(err) : res({ address, family })
            )
        );
        const lookup = await new Promise((res, rej) =>
            dns.lookup(host, (err: any, address: any, family: any) =>
                err ? rej(err) : res({ address, family })
            )
        );
        assert.deepEqual(nodeLookup, lookup);
    });
    test("promises.lookup (single)", async () => {
        const host = "testa.fullstacked.org";
        const nodeLookup = await nodeDns.promises.lookup(host);
        const lookup = await dns.promises.lookup(host);
        assert.deepEqual(nodeLookup, lookup);
    });
});
