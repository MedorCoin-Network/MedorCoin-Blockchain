"use strict";

const fs = require("node:fs");
const { MedacNode } = require("./medac_node.cjs");
const consensus = require("./medac_consensus.cjs");

function readOptionalFile(filePath) {
    return filePath ? fs.readFileSync(filePath) : undefined;
}

function parsePort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new RangeError("MEDAC_PORT must be between 1 and 65535");
    }
    return port;
}

async function main() {
    const host = process.env.MEDAC_HOST || "127.0.0.1";
    const tlsKey = readOptionalFile(process.env.MEDAC_TLS_KEY);
    const tlsCert = readOptionalFile(process.env.MEDAC_TLS_CERT);
    const tlsCa = readOptionalFile(process.env.MEDAC_TLS_CA);
    const tls = tlsKey && tlsCert ? {
        key: tlsKey,
        cert: tlsCert,
        ca: tlsCa,
        requestCert: Boolean(tlsCa),
        rejectUnauthorized: Boolean(tlsCa)
    } : null;
    const initialTarget = process.env.MEDAC_INITIAL_TARGET;
    const maxTarget = process.env.MEDAC_MAX_TARGET;
    const peers = (process.env.MEDAC_PEERS || "").split(",").map((peer) => peer.trim()).filter(Boolean);

    const node = new MedacNode({
        host,
        port: parsePort(process.env.MEDAC_PORT || process.env.PORT || "19444"),
        dataDir: process.env.MEDAC_DATA_DIR || "./medac-data",
        seedPeers: peers,
        tls,
        trustProxyTls: process.env.MEDAC_TRUST_PROXY_TLS === "true",
        consensus: {
            ...(initialTarget ? { initialTarget: BigInt(initialTarget) } : {}),
            ...(maxTarget ? { maxTarget: BigInt(maxTarget) } : {})
        }
    });

    await node.start();
    const address = node.address();
    console.log(`MEDAC ${consensus.NETWORK_ID} listening on ${address.address}:${address.port}`);
    console.log(`Genesis: ${node.chain.state.genesisHash}`);
    console.log(`Height: ${node.chain.state.height}; cumulative work: ${node.chain.state.cumulativeWork}`);

    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`MEDAC received ${signal}; flushing and shutting down.`);
        await node.stop();
    };
    process.once("SIGINT", () => { void shutdown("SIGINT"); });
    process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
}

main().catch((error) => {
    console.error(`MEDAC startup failed: ${error.message}`);
    process.exitCode = 1;
});
