"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { MedacNode } = require("./medac_node.cjs");

test("serves the dashboard and live node state", async (t) => {
    const node = new MedacNode({ host: "127.0.0.1", port: 0 });
    await node.start();
    t.after(() => node.stop());

    const { port } = node.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const pageResponse = await fetch(`${baseUrl}/`);
    assert.equal(pageResponse.status, 200);
    assert.match(await pageResponse.text(), /Medac \| Blockchain Dashboard/);

    const dashboardResponse = await fetch(`${baseUrl}/api/dashboard`);
    assert.equal(dashboardResponse.status, 200);
    assert.match(dashboardResponse.headers.get("content-type"), /application\/json/);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.status, "ok");
    assert.equal(dashboard.height, 0);
    assert.equal(dashboard.peerCount, 0);
    assert.deepEqual(dashboard.peers, []);
    assert.deepEqual(dashboard.recentBlocks, []);
    assert.equal(BigInt(dashboard.tokenomics.totalSupplyCap), 100_000_000n * 10n ** 18n);
    assert.equal(BigInt(dashboard.tokenomics.genesisSupply), 30_000_000n * 10n ** 18n);
    assert.equal(BigInt(dashboard.tokenomics.miningReserve), 70_000_000n * 10n ** 18n);
    assert.equal(typeof dashboard.genesisHash, "string");

    const healthResponse = await fetch(`${baseUrl}/healthz`);
    assert.equal(healthResponse.status, 200);
    assert.equal((await healthResponse.json()).status, "ok");
});