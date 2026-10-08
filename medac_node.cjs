"use strict";

const EventEmitter = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const WebSocket = require("ws");
const consensus = require("./medac_consensus.cjs");
const { MedacChain, MAX_CHAIN_BLOCKS } = require("./medac_chain.cjs");

const MAX_PEERS = 32;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_BLOCKS_PER_RESPONSE = 100;
const MAX_MESSAGES_PER_SECOND = 40;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

function isLoopback(host) {
    const value = host.toLowerCase();
    return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]";
}

class MedacNode extends EventEmitter {
    constructor(options = {}) {
        super();
        this.host = options.host || "127.0.0.1";
        this.port = options.port === undefined ? 19444 : options.port;
        this.seedPeers = options.seedPeers || [];
        this.maxPeers = options.maxPeers || MAX_PEERS;
        this.tls = options.tls || null;
        this.trustProxyTls = options.trustProxyTls === true;
        if (!Array.isArray(this.seedPeers) || !Number.isInteger(this.maxPeers)
            || this.maxPeers < 1 || this.maxPeers > MAX_PEERS) {
            throw new TypeError("Invalid MEDAC node configuration");
        }
        if (!isLoopback(this.host) && (!this.tls || !this.tls.key || !this.tls.cert)
            && !this.trustProxyTls) {
            throw new Error("TLS key and certificate are required for non-loopback MEDAC listeners");
        }
        this.chain = new MedacChain({ dataDir: options.dataDir, consensus: options.consensus });
        this.peers = new Map();
        this.mempool = new Map();
        this.reconnectAttempts = new Map();
        this.reconnectTimers = new Map();
        this.server = null;
        this.httpServer = null;
        this.httpsServer = null;
        this.heartbeat = null;
        this.started = false;
        this.stopping = false;
    }

    async start() {
        if (this.started) return this;
        await this.chain.open();
        try {
            if (this.tls) {
                this.httpsServer = https.createServer({
                    key: this.tls.key,
                    cert: this.tls.cert,
                    ca: this.tls.ca,
                    requestCert: Boolean(this.tls.requestCert),
                    rejectUnauthorized: Boolean(this.tls.rejectUnauthorized)
                }, (request, response) => this._handleHttpRequest(request, response));
                this.server = new WebSocket.Server({
                    server: this.httpsServer,
                    maxPayload: MAX_MESSAGE_BYTES,
                    perMessageDeflate: false
                });
                await new Promise((resolve, reject) => {
                    this.httpsServer.once("error", reject);
                    this.httpsServer.listen(this.port, this.host, resolve);
                });
            } else {
                this.httpServer = http.createServer((request, response) => this._handleHttpRequest(request, response));
                this.server = new WebSocket.Server({
                    server: this.httpServer,
                    maxPayload: MAX_MESSAGE_BYTES,
                    perMessageDeflate: false
                });
                await new Promise((resolve, reject) => {
                    this.httpServer.once("listening", resolve);
                    this.httpServer.once("error", reject);
                    this.httpServer.listen(this.port, this.host);
                });
            }
            this.server.on("connection", (socket, request) => {
                const address = request.socket.remoteAddress || "unknown";
                this._attachPeer(socket, null, address);
            });
            this.heartbeat = setInterval(() => this._heartbeatPeers(), HEARTBEAT_INTERVAL_MS);
            this.heartbeat.unref();
            this.started = true;
            for (const peerUrl of this.seedPeers) this.connectTo(peerUrl);
            this.emit("listening", this.address());
            return this;
        } catch (error) {
            if (this.server) this.server.close();
            if (this.httpServer) this.httpServer.close();
            if (this.httpsServer) this.httpsServer.close();
            await this.chain.close();
            throw error;
        }
    }

    address() {
        return this.server ? this.server.address() : null;
    }

    _handleHttpRequest(request, response) {
        const pathname = request.url.split("?")[0];
        if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
            fs.readFile(path.join(__dirname, "index.html"))
                .then((html) => {
                    response.writeHead(200, {
                        "content-type": "text/html; charset=utf-8",
                        "cache-control": "no-cache"
                    });
                    response.end(html);
                })
                .catch(() => {
                    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
                    response.end("Dashboard unavailable");
                });
            return;
        }
        if (request.method === "GET" && pathname === "/api/dashboard") {
            const state = this.chain.state;
            const peers = [...this.peers.values()]
                .filter((peer) => peer.ready)
                .map((peer) => ({
                    address: peer.label,
                    height: peer.height,
                    direction: peer.peerUrl ? "outbound" : "inbound"
                }));
            const recentBlocks = state.blocks.slice(-5).reverse().map((block) => ({
                height: block.height,
                hash: block.hash,
                timestamp: block.timestamp,
                minerAddress: block.minerAddress,
                reward: block.reward,
                transactionCount: block.transactions.length
            }));
            response.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store"
            });
            response.end(JSON.stringify({
                status: "ok",
                networkId: consensus.NETWORK_ID,
                genesisHash: state.genesisHash,
                height: state.height,
                tipHash: state.tipHash,
                timestamp: state.timestamp,
                totalSupply: state.totalSupply.toString(),
                tokenomics: {
                    totalSupplyCap: consensus.TOTAL_SUPPLY.toString(),
                    genesisSupply: consensus.GENESIS_SUPPLY.toString(),
                    miningReserve: consensus.MINING_RESERVE.toString(),
                    initialBlockReward: consensus.INITIAL_BLOCK_REWARD.toString(),
                    halvingInterval: consensus.HALVING_INTERVAL,
                    targetBlockTime: consensus.TARGET_BLOCK_TIME
                },
                pendingTransactions: this.mempool.size,
                peerCount: peers.length,
                peers,
                recentBlocks
            }));
            return;
        }
        if (request.method === "GET" && request.url.split("?")[0] === "/healthz") {
            const state = this.chain.state;
            response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({
                status: "ok",
                networkId: consensus.NETWORK_ID,
                genesisHash: state.genesisHash,
                height: state.height
            }));
            return;
        }
        response.writeHead(404);
        response.end();
    }

    connectTo(peerUrl) {
        if (this.stopping || this.peers.size >= this.maxPeers) return;
        let parsed;
        try { parsed = new URL(peerUrl); } catch { throw new TypeError("Invalid MEDAC peer URL"); }
        if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
            throw new TypeError("MEDAC peers must use ws:// or wss://");
        }
        if (parsed.protocol === "ws:" && !isLoopback(parsed.hostname)) {
            throw new Error("Unencrypted MEDAC peer connections are allowed only on loopback");
        }
        if ([...this.peers.values()].some((peer) => peer.peerUrl === peerUrl)) return;
        const socket = new WebSocket(peerUrl, {
            maxPayload: MAX_MESSAGE_BYTES,
            perMessageDeflate: false,
            rejectUnauthorized: true
        });
        socket.once("open", () => {
            this.reconnectAttempts.delete(peerUrl);
            this._attachPeer(socket, peerUrl, peerUrl);
        });
        socket.on("error", () => {});
        socket.once("close", () => {
            if (!this.peers.has(peerUrl)) this._scheduleReconnect(peerUrl);
        });
    }

    async submitTransaction(transaction) {
        const normalized = consensus.normalizeTransaction(transaction);
        const id = consensus.transactionId(normalized);
        if (this.mempool.has(id)) return id;
        const pending = [...this.mempool.values()];
        await this.chain.acceptTransaction(normalized, pending);
        this.mempool.set(id, normalized);
        this._broadcast({ type: "transaction", transaction: normalized });
        this.emit("transaction", normalized);
        return id;
    }

    async mine(minerAddress, options = {}) {
        if (!this.started) throw new Error("MEDAC node is not running");
        const state = this.chain.state;
        const timestamp = options.timestamp === undefined
            ? Math.max(Math.floor(Date.now() / 1000), state.timestamp + 1)
            : options.timestamp;
        const transactions = [...this.mempool.values()].slice(0, consensus.MAX_TRANSACTIONS_PER_BLOCK);
        const result = await consensus.mineBlockAsync(state, minerAddress, timestamp, transactions, {
            shouldCancel: () => this.stopping || this.chain.state.tipHash !== state.tipHash,
            batchSize: options.batchSize
        });
        await this.chain.appendBlock(result.block);
        this._removeIncludedTransactions(result.block.transactions);
        this._broadcast({ type: "block", block: result.block });
        this._broadcastStatus();
        this.emit("block", result.block);
        return result.block;
    }

    async stop() {
        if (this.stopping) return;
        this.stopping = true;
        clearInterval(this.heartbeat);
        for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
        this.reconnectTimers.clear();
        for (const peer of this.peers.values()) peer.socket.terminate();
        this.peers.clear();
        if (this.server) {
            await new Promise((resolve) => this.server.close(() => resolve()));
            this.server = null;
        }
        if (this.httpServer) {
            await new Promise((resolve) => this.httpServer.close(() => resolve()));
            this.httpServer = null;
        }
        if (this.httpsServer) {
            await new Promise((resolve) => this.httpsServer.close(() => resolve()));
            this.httpsServer = null;
        }
        await this.chain.close();
        this.started = false;
    }

    _attachPeer(socket, peerUrl, label) {
        if (this.stopping || this.peers.size >= this.maxPeers) {
            socket.close(1008, "Peer capacity reached");
            return;
        }
        const peer = {
            id: peerUrl || `${label}:${Date.now()}:${Math.random()}`,
            label,
            peerUrl,
            socket,
            ready: false,
            versionSent: false,
            alive: true,
            messageWindow: Date.now(),
            messageCount: 0,
            sync: null,
            handshakeTimer: null
        };
        this.peers.set(peer.id, peer);
        peer.handshakeTimer = setTimeout(() => {
            if (!peer.ready) socket.terminate();
        }, HANDSHAKE_TIMEOUT_MS);
        peer.handshakeTimer.unref();
        socket.on("pong", () => { peer.alive = true; });
        socket.on("message", (raw) => this._handleMessage(peer, raw));
        socket.on("close", () => this._removePeer(peer));
        socket.on("error", () => socket.terminate());
        this._sendVersion(peer);
    }

    _sendVersion(peer) {
        if (peer.versionSent) return;
        peer.versionSent = true;
        const state = this.chain.state;
        this._send(peer, {
            type: "version",
            networkId: consensus.NETWORK_ID,
            genesisHash: state.genesisHash,
            height: state.height,
            tipHash: state.tipHash,
            cumulativeWork: state.cumulativeWork.toString()
        });
    }

    _handleMessage(peer, raw) {
        if (raw.length > MAX_MESSAGE_BYTES) return peer.socket.close(1009, "Message too large");
        const now = Date.now();
        if (now - peer.messageWindow >= 1000) {
            peer.messageWindow = now;
            peer.messageCount = 0;
        }
        if (++peer.messageCount > MAX_MESSAGES_PER_SECOND) return peer.socket.close(1008, "Rate limit exceeded");

        let message;
        try {
            message = JSON.parse(raw.toString());
        } catch {
            return peer.socket.close(1003, "Malformed JSON");
        }
        if (!message || typeof message.type !== "string") return peer.socket.close(1003, "Malformed message");

        if (message.type === "version") {
            if (message.networkId !== consensus.NETWORK_ID
                || message.genesisHash !== this.chain.state.genesisHash
                || !Number.isSafeInteger(message.height) || message.height < 0
                || message.height > MAX_CHAIN_BLOCKS
                || typeof message.cumulativeWork !== "string"
                || message.cumulativeWork.length > 100
                || !/^(0|[1-9][0-9]*)$/.test(message.cumulativeWork)) {
                return peer.socket.close(1008, "MEDAC network mismatch");
            }
            peer.ready = true;
            clearTimeout(peer.handshakeTimer);
            peer.height = message.height;
            peer.cumulativeWork = BigInt(message.cumulativeWork);
            this._sendVersion(peer);
            this.emit("peer", peer.label);
            if (peer.cumulativeWork > this.chain.state.cumulativeWork) this._requestBlocks(peer);
            return;
        }
        if (!peer.ready) return peer.socket.close(1008, "Handshake required");

        try {
            switch (message.type) {
                case "get_blocks": return this._serveBlocks(peer, message);
                case "blocks": return this._receiveBlocks(peer, message);
                case "block": return void this._receiveBlock(peer, message.block);
                case "transaction": return void this.submitTransaction(message.transaction).catch(() => {});
                case "ping": return this._send(peer, { type: "pong" });
                case "pong": return;
                default: return peer.socket.close(1008, "Unknown MEDAC message");
            }
        } catch {
            peer.socket.close(1008, "Invalid MEDAC message");
        }
    }

    _serveBlocks(peer, request) {
        const blocks = this.chain.state.blocks;
        let commonHeight = -1;
        if (Array.isArray(request.locator) && request.locator.length <= 100) {
            const heights = new Map([[this.chain.state.genesisHash, 0]]);
            for (const block of blocks) heights.set(block.hash, block.height);
            for (const hash of request.locator) {
                if (typeof hash === "string" && heights.has(hash)) {
                    commonHeight = heights.get(hash);
                    break;
                }
            }
            if (commonHeight < 0) return this._send(peer, { type: "blocks", restart: true });
        } else if (typeof request.afterHash === "string") {
            if (request.afterHash === this.chain.state.genesisHash) {
                commonHeight = 0;
            } else {
                const blockIndex = blocks.findIndex((block) => block.hash === request.afterHash);
                if (blockIndex < 0) return this._send(peer, { type: "blocks", restart: true });
                commonHeight = blockIndex + 1;
            }
        } else {
            return this._send(peer, { type: "blocks", restart: true });
        }

        const result = [];
        while (commonHeight + result.length < blocks.length && result.length < MAX_BLOCKS_PER_RESPONSE) {
            result.push(blocks[commonHeight + result.length]);
            const candidate = {
                type: "blocks",
                commonHeight,
                blocks: result,
                more: commonHeight + result.length < blocks.length,
                tipHeight: blocks.length
            };
            if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_MESSAGE_BYTES) {
                result.pop();
                if (result.length === 0) return peer.socket.close(1009, "MEDAC block exceeds message limit");
                break;
            }
        }
        this._send(peer, {
            type: "blocks",
            commonHeight,
            blocks: result,
            more: commonHeight + result.length < blocks.length,
            tipHeight: blocks.length
        });
    }

    _receiveBlocks(peer, response) {
        if (response.restart) {
            peer.sync = null;
            return this._requestBlocks(peer);
        }
        if (!Number.isSafeInteger(response.commonHeight) || response.commonHeight < 0
            || !Array.isArray(response.blocks) || response.blocks.length > MAX_BLOCKS_PER_RESPONSE
            || typeof response.more !== "boolean"
            || !Number.isSafeInteger(response.tipHeight) || response.tipHeight < response.commonHeight
            || response.tipHeight > MAX_CHAIN_BLOCKS) {
            throw new Error("Invalid MEDAC block batch");
        }
        if (!peer.sync) {
            if (response.commonHeight > this.chain.state.height) throw new Error("Unknown common block");
            peer.sync = { blocks: this.chain.state.blocks.slice(0, response.commonHeight) };
        }
        if (response.blocks.length === 0 && response.more) throw new Error("Empty MEDAC block batch");
        peer.sync.blocks.push(...response.blocks);
        if (peer.sync.blocks.length > MAX_CHAIN_BLOCKS) throw new Error("MEDAC sync exceeds block limit");

        if (response.more) {
            const last = peer.sync.blocks[peer.sync.blocks.length - 1];
            this._send(peer, { type: "get_blocks", afterHash: last ? last.hash : this.chain.state.genesisHash });
            return;
        }

        const candidate = peer.sync.blocks;
        if (candidate.length !== response.tipHeight) throw new Error("Incomplete MEDAC chain response");
        peer.sync = null;
        this.chain.considerChain(candidate).then((result) => {
            if (result.adopted) {
                this._revalidateMempool();
                this.emit("reorg", result.previousTip, result.state.tipHash);
                this._broadcastStatus();
            }
        }).catch(() => peer.socket.close(1008, "Invalid MEDAC chain"));
    }

    async _receiveBlock(peer, block) {
        try {
            await this.chain.appendBlock(block);
            this._removeIncludedTransactions(block.transactions);
            this._broadcast({ type: "block", block }, peer);
            this._broadcastStatus();
            this.emit("block", block);
        } catch {
            this._requestBlocks(peer);
        }
    }

    _requestBlocks(peer) {
        const blocks = this.chain.state.blocks;
        const locator = [];
        let index = blocks.length - 1;
        let step = 1;
        while (index >= 0 && locator.length < 32) {
            locator.push(blocks[index].hash);
            index -= step;
            if (locator.length > 10) step *= 2;
        }
        locator.push(this.chain.state.genesisHash);
        peer.sync = null;
        this._send(peer, { type: "get_blocks", locator });
    }

    _removeIncludedTransactions(transactions) {
        for (const transaction of transactions || []) {
            try { this.mempool.delete(consensus.transactionId(transaction)); } catch {}
        }
        this._revalidateMempool();
    }

    _revalidateMempool() {
        const retained = new Map();
        for (const [id, transaction] of this.mempool) {
            try {
                consensus.validateTransactionSequence(this.chain.state, [...retained.values(), transaction]);
                retained.set(id, transaction);
            } catch {}
        }
        this.mempool = retained;
    }

    _broadcastStatus() {
        const state = this.chain.state;
        this._broadcast({
            type: "version",
            networkId: consensus.NETWORK_ID,
            genesisHash: state.genesisHash,
            height: state.height,
            tipHash: state.tipHash,
            cumulativeWork: state.cumulativeWork.toString()
        });
    }

    _broadcast(message, except = null) {
        for (const peer of this.peers.values()) {
            if (peer.ready && peer !== except) this._send(peer, message);
        }
    }

    _send(peer, message) {
        if (peer.socket.readyState !== WebSocket.OPEN) return;
        const encoded = JSON.stringify(message);
        if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) {
            peer.socket.close(1009, "Outbound MEDAC message too large");
            return;
        }
        peer.socket.send(encoded);
    }

    _heartbeatPeers() {
        for (const peer of this.peers.values()) {
            if (!peer.alive) {
                peer.socket.terminate();
                continue;
            }
            peer.alive = false;
            peer.socket.ping();
        }
    }

    _removePeer(peer) {
        clearTimeout(peer.handshakeTimer);
        this.peers.delete(peer.id);
        if (peer.peerUrl && !this.stopping) this._scheduleReconnect(peer.peerUrl);
    }

    _scheduleReconnect(peerUrl) {
        if (this.reconnectTimers.has(peerUrl) || this.stopping) return;
        const attempt = (this.reconnectAttempts.get(peerUrl) || 0) + 1;
        this.reconnectAttempts.set(peerUrl, attempt);
        const delay = Math.min(1_000 * (2 ** Math.min(attempt - 1, 6)), 60_000);
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(peerUrl);
            this.connectTo(peerUrl);
        }, delay);
        timer.unref();
        this.reconnectTimers.set(peerUrl, timer);
    }
}

module.exports = Object.freeze({ MedacNode });
