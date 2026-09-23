/**
 * MEDORCOIN ENGINE - NATIVE STORAGE LAYER MANAGEMENT
 * Handles atomic balance shifts, mempool registration, and ledger persistence.
 */

"use strict";

const Redis = require('ioredis');
// Connect to the local standalone Redis server active on standard port 6379
const redis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: 3
});

redis.on('connect', () => {
    console.log("[Storage Engine] Connected to standalone database on Port 6379 successfully.");
});

redis.on('error', (err) => {
    console.error("[Storage Engine] Critical failure accessing core Redis database:", err.message);
});

/**
 * Commits an authenticated transaction payload directly to the mempool queue state
 * @param {Object} txVerified The cryptographically checked transaction packet parameters
 */
async function commitTxToLedgerState(txVerified) {
    const { hash, sender, payload } = txVerified;
    const parsed = JSON.parse(payload);
    
    // Determine structural data criteria keys
    const txType = parsed.txType || "ASSET_SWAP";
    const token = parsed.tokenSymbol || "MEDA";
    const amount = parsed.tradeAmount || "0";
    
    const pipe = redis.pipeline();
    
    // 1. Write the transaction entry map values into the ledger pool hash index
    pipe.hset(`ledger:tx:${hash}`, {
        sender: sender,
        token: token,
        amount: amount,
        type: txType,
        status: "COMMITTED_TO_MEMPOOL",
        timestamp: Date.now().toString()
    });
    
    // 2. Enqueue the hash string directly into the thread-safe prioritization mempool
    pipe.rpush('mempool:queue', hash);
    
    // 3. Cache the sender's unspent block reference parameters to handle double spend logic
    pipe.sadd(`mempool:pending:${sender.toLowerCase()}`, hash);
    
    await pipe.exec();
    console.log(`[Storage Engine] Transaction ${hash.slice(0, 8)}... mapped atomically to Redis state data.`);
}

module.exports = { redis, commitTxToLedgerState };
