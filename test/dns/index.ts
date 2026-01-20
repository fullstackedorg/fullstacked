import test, { suite } from "node:test";
import assert from "node:assert";
import * as dns from "../../core/internal/bundle/lib/dns/index.ts";
import * as nodeDns from "node:dns";

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
});
