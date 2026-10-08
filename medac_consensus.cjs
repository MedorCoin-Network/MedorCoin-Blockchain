"use strict";

const crypto = require("node:crypto");
const { verifyMessage } = require("ethers");

const NETWORK_ID = "MEDAC-POW-1";
const TOKEN = 10n ** 18n;
const TOTAL_SUPPLY = 100_000_000n * TOKEN;
const GENESIS_SUPPLY = 30_000_000n * TOKEN;
const MINING_RESERVE = TOTAL_SUPPLY - GENESIS_SUPPLY;
const HALVING_INTERVAL = 300_000;
const MAX_HASH = (1n << 256n) - 1n;
const DEFAULT_INITIAL_TARGET = MAX_HASH >> 32n;
const DEFAULT_MAX_TARGET = MAX_HASH >> 28n;
const TARGET_BLOCK_TIME = 60;
const RETARGET_WINDOW = 20;
const RETARGET_FACTOR = 4n;
const MAX_FUTURE_SECONDS = 2 * 60 * 60;
const MAX_TRANSACTIONS_PER_BLOCK = 100;
const MIN_TRANSACTION_FEE = 10n ** 14n;
const MAX_AMOUNT_DIGITS = TOTAL_SUPPLY.toString().length;
const GENESIS_ALLOCATIONS = Object.freeze([
    Object.freeze({ address: "0xD81e7078bEE7ad3a313a74ED171E2941b7455f1D", amount: 10_000_000n * TOKEN }),
    Object.freeze({ address: "0x75E642510D48df5fff33d507748f6dE2FaB3592A", amount: 10_000_000n * TOKEN }),
    Object.freeze({ address: "0xA44FE7604F3B26b8dEf551fA7a6F25e06381D07F", amount: 10_000_000n * TOKEN })
]);

function scheduledSupply(initialReward) {
    let total = 0n;
    for (let reward = initialReward; reward > 0n; reward >>= 1n) {
        total += reward * BigInt(HALVING_INTERVAL);
    }
    return total;
}

function findInitialBlockReward() {
    let low = 0n;
    let high = (MINING_RESERVE + 2n * BigInt(HALVING_INTERVAL) - 1n)
        / (2n * BigInt(HALVING_INTERVAL));
    while (scheduledSupply(high) < MINING_RESERVE) high *= 2n;
    while (low + 1n < high) {
        const middle = (low + high) >> 1n;
        if (scheduledSupply(middle) >= MINING_RESERVE) high = middle;
        else low = middle;
    }
    return high;
}

const INITIAL_BLOCK_REWARD = findInitialBlockReward();

function normalizeAddress(address) {
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)
        || /^0x0{40}$/i.test(address)) {
        throw new TypeError("Invalid MEDAC address");
    }
    return address.toLowerCase();
}

function parseConsensusConfig(options = {}) {
    const config = {
        initialTarget: options.initialTarget === undefined ? DEFAULT_INITIAL_TARGET : BigInt(options.initialTarget),
        maxTarget: options.maxTarget === undefined ? DEFAULT_MAX_TARGET : BigInt(options.maxTarget),
        targetBlockTime: options.targetBlockTime === undefined ? TARGET_BLOCK_TIME : options.targetBlockTime,
        retargetWindow: options.retargetWindow === undefined ? RETARGET_WINDOW : options.retargetWindow
    };
    if (config.initialTarget < 1n || config.initialTarget > config.maxTarget
        || config.maxTarget > MAX_HASH
        || !Number.isSafeInteger(config.targetBlockTime) || config.targetBlockTime < 1
        || !Number.isSafeInteger(config.retargetWindow) || config.retargetWindow < 2
        || config.retargetWindow > 10_000) {
        throw new RangeError("Invalid MEDAC consensus configuration");
    }
    return Object.freeze(config);
}

function calculateBlockReward(height, miningIssued = 0n) {
    if (!Number.isSafeInteger(height) || height < 1) return 0n;
    if (typeof miningIssued !== "bigint" || miningIssued < 0n || miningIssued > MINING_RESERVE) {
        throw new RangeError("Invalid MEDAC mining issuance state");
    }
    const remaining = MINING_RESERVE - miningIssued;
    if (remaining === 0n) return 0n;
    const halvings = BigInt(Math.floor((height - 1) / HALVING_INTERVAL));
    const scheduledReward = INITIAL_BLOCK_REWARD >> halvings;
    if (scheduledReward === 0n) return 0n;
    return scheduledReward < remaining ? scheduledReward : remaining;
}

function getGenesisHash(config) {
    const allocations = GENESIS_ALLOCATIONS.map(({ address, amount }) => [
        normalizeAddress(address), amount.toString()
    ]);
    return crypto.createHash("sha256").update(JSON.stringify([
        NETWORK_ID,
        "GENESIS",
        allocations,
        config.initialTarget.toString(),
        config.maxTarget.toString(),
        config.targetBlockTime,
        config.retargetWindow
    ])).digest("hex");
}

function createGenesisState(options = {}) {
    const consensus = parseConsensusConfig(options);
    const balances = new Map();
    for (const allocation of GENESIS_ALLOCATIONS) {
        balances.set(normalizeAddress(allocation.address), allocation.amount);
    }
    const genesisHash = getGenesisHash(consensus);
    return {
        height: 0,
        tipHash: genesisHash,
        genesisHash,
        timestamp: 0,
        target: consensus.initialTarget,
        cumulativeWork: 0n,
        totalSupply: GENESIS_SUPPLY,
        balanceTotal: GENESIS_SUPPLY,
        miningIssued: 0n,
        balances,
        nonces: new Map(),
        blocks: [],
        consensus
    };
}

function transactionSigningPayload(transaction) {
    const from = normalizeAddress(transaction.from);
    const to = normalizeAddress(transaction.to);
    if (typeof transaction.genesisHash !== "string" || !/^[0-9a-f]{64}$/.test(transaction.genesisHash)
        || !Number.isSafeInteger(transaction.nonce) || transaction.nonce < 0
        || transaction.nonce === Number.MAX_SAFE_INTEGER
        || typeof transaction.amount !== "string" || !/^[1-9][0-9]*$/.test(transaction.amount)
        || transaction.amount.length > MAX_AMOUNT_DIGITS
        || typeof transaction.fee !== "string" || !/^(0|[1-9][0-9]*)$/.test(transaction.fee)
        || transaction.fee.length > MAX_AMOUNT_DIGITS) {
        throw new TypeError("Malformed MEDAC transaction fields");
    }
    return JSON.stringify([
        NETWORK_ID,
        transaction.genesisHash,
        from,
        to,
        transaction.nonce,
        transaction.amount,
        transaction.fee
    ]);
}

function normalizeTransaction(transaction) {
    if (!transaction || typeof transaction !== "object"
        || typeof transaction.signature !== "string"
        || !/^0x[0-9a-fA-F]{130}$/.test(transaction.signature)) {
        throw new TypeError("Malformed MEDAC transaction signature");
    }
    const normalized = {
        genesisHash: transaction.genesisHash,
        from: normalizeAddress(transaction.from),
        to: normalizeAddress(transaction.to),
        nonce: transaction.nonce,
        amount: transaction.amount,
        fee: transaction.fee,
        signature: transaction.signature.toLowerCase()
    };
    const payload = transactionSigningPayload(normalized);
    if (BigInt(normalized.amount) > TOTAL_SUPPLY || BigInt(normalized.fee) < MIN_TRANSACTION_FEE
        || BigInt(normalized.fee) > TOTAL_SUPPLY) {
        throw new RangeError("MEDAC transaction amount or fee is out of range");
    }
    const recovered = normalizeAddress(verifyMessage(payload, normalized.signature));
    if (recovered !== normalized.from) throw new Error("MEDAC transaction signer mismatch");
    return normalized;
}

function transactionId(transaction) {
    return crypto.createHash("sha256").update(JSON.stringify([
        transactionSigningPayload(transaction), transaction.signature.toLowerCase()
    ])).digest("hex");
}

function applyTransactions(state, transactions) {
    if (!Array.isArray(transactions) || transactions.length > MAX_TRANSACTIONS_PER_BLOCK) {
        throw new Error("Invalid MEDAC block transaction list");
    }
    const balances = new Map(state.balances);
    const nonces = new Map(state.nonces);
    const seen = new Set();
    let totalFees = 0n;

    for (const rawTransaction of transactions) {
        const transaction = normalizeTransaction(rawTransaction);
        if (transaction.genesisHash !== state.genesisHash) {
            throw new Error("MEDAC transaction belongs to another genesis network");
        }
        const id = transactionId(transaction);
        if (seen.has(id)) throw new Error("Duplicate MEDAC transaction");
        seen.add(id);

        const expectedNonce = nonces.get(transaction.from) || 0;
        if (transaction.nonce !== expectedNonce) throw new Error("Incorrect MEDAC transaction nonce");
        const amount = BigInt(transaction.amount);
        const fee = BigInt(transaction.fee);
        const senderBalance = balances.get(transaction.from) || 0n;
        if (senderBalance < amount + fee) throw new Error("Insufficient MEDAC transaction balance");

        balances.set(transaction.from, senderBalance - amount - fee);
        balances.set(transaction.to, (balances.get(transaction.to) || 0n) + amount);
        nonces.set(transaction.from, expectedNonce + 1);
        totalFees += fee;
    }
    return { balances, nonces, totalFees };
}

function validateTransactionSequence(state, transactions) {
    return applyTransactions(state, transactions);
}

function hashBlockHeader(block, genesisHash) {
    return crypto.createHash("sha256").update(JSON.stringify([
        NETWORK_ID,
        genesisHash,
        block.height,
        block.previousHash,
        block.timestamp,
        String(block.nonce),
        normalizeAddress(block.minerAddress),
        String(block.reward),
        String(block.target),
        block.transactions.map(normalizeTransaction)
    ])).digest("hex");
}

function blockWork(target) {
    return (1n << 256n) / (target + 1n);
}

function calculateNextTarget(state, nextHeight, timestamp) {
    if (nextHeight % state.consensus.retargetWindow !== 0) return state.target;
    const anchorIndex = state.blocks.length - (state.consensus.retargetWindow - 1);
    const anchor = anchorIndex >= 0 ? state.blocks[anchorIndex].timestamp : 0;
    const expected = (state.consensus.retargetWindow - 1) * state.consensus.targetBlockTime;
    const actual = Math.max(1, timestamp - anchor);
    const bounded = Math.max(Math.floor(expected / Number(RETARGET_FACTOR)),
        Math.min(actual, expected * Number(RETARGET_FACTOR)));
    let target = state.target * BigInt(bounded) / BigInt(expected);
    if (target < 1n) target = 1n;
    if (target > state.consensus.maxTarget) target = state.consensus.maxTarget;
    return target;
}

function assertValidState(state) {
    if (!state || !Number.isSafeInteger(state.height) || state.height < 0
        || !Number.isSafeInteger(state.timestamp) || state.timestamp < 0
        || typeof state.tipHash !== "string" || !/^[0-9a-f]{64}$/.test(state.tipHash)
        || typeof state.genesisHash !== "string" || !/^[0-9a-f]{64}$/.test(state.genesisHash)
        || typeof state.totalSupply !== "bigint" || state.totalSupply !== GENESIS_SUPPLY + state.miningIssued
        || typeof state.balanceTotal !== "bigint" || state.balanceTotal !== state.totalSupply
        || typeof state.miningIssued !== "bigint" || state.miningIssued < 0n || state.miningIssued > MINING_RESERVE
        || state.totalSupply > TOTAL_SUPPLY
        || !(state.balances instanceof Map) || !(state.nonces instanceof Map)
        || !Array.isArray(state.blocks) || state.blocks.length !== state.height
        || typeof state.target !== "bigint" || state.target < 1n
        || typeof state.cumulativeWork !== "bigint" || state.cumulativeWork < 0n) {
        throw new Error("Invalid MEDAC consensus state");
    }
    const config = parseConsensusConfig(state.consensus);
    if (getGenesisHash(config) !== state.genesisHash || state.target > config.maxTarget
        || (state.height > 0 && (state.blocks[state.height - 1].hash !== state.tipHash
            || state.blocks[state.height - 1].timestamp !== state.timestamp))) {
        throw new Error("MEDAC consensus state integrity mismatch");
    }
}

function applyMinedBlock(state, block) {
    assertValidState(state);
    if (!block || !Number.isSafeInteger(block.height) || block.height !== state.height + 1) {
        throw new Error("Invalid MEDAC block height");
    }
    if (block.previousHash !== state.tipHash) throw new Error("MEDAC previous hash mismatch");
    if (!Number.isSafeInteger(block.timestamp) || block.timestamp <= state.timestamp
        || block.timestamp > Math.floor(Date.now() / 1000) + MAX_FUTURE_SECONDS) {
        throw new Error("Invalid MEDAC block timestamp");
    }
    if (typeof block.nonce !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(block.nonce)
        || BigInt(block.nonce) > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Invalid MEDAC proof-of-work nonce");
    }

    const minerAddress = normalizeAddress(block.minerAddress);
    const expectedTarget = state.target;
    if (typeof block.target !== "string" || !/^[1-9][0-9]*$/.test(block.target)
        || BigInt(block.target) !== expectedTarget) {
        throw new Error("Incorrect MEDAC proof-of-work target");
    }
    const expectedReward = calculateBlockReward(block.height, state.miningIssued);
    if (typeof block.reward !== "string" || !/^(0|[1-9][0-9]*)$/.test(block.reward)
        || BigInt(block.reward) !== expectedReward) {
        throw new Error("Incorrect MEDAC miner reward");
    }

    const { balances, nonces, totalFees } = applyTransactions(state, block.transactions);
    const medianTimes = state.blocks.slice(-11).map((item) => item.timestamp).sort((a, b) => a - b);
    if (medianTimes.length > 0 && block.timestamp <= medianTimes[Math.floor(medianTimes.length / 2)]) {
        throw new Error("MEDAC block timestamp is not above median time");
    }

    const calculatedHash = hashBlockHeader(block, state.genesisHash);
    if (typeof block.hash !== "string" || !/^[0-9a-f]{64}$/.test(block.hash)
        || block.hash !== calculatedHash || BigInt(`0x${calculatedHash}`) > expectedTarget) {
        throw new Error("Invalid MEDAC proof of work");
    }

    balances.set(minerAddress, (balances.get(minerAddress) || 0n) + expectedReward + totalFees);
    const normalizedBlock = {
        height: block.height,
        previousHash: block.previousHash,
        timestamp: block.timestamp,
        nonce: block.nonce,
        minerAddress,
        reward: expectedReward.toString(),
        target: expectedTarget.toString(),
        transactions: block.transactions.map(normalizeTransaction),
        hash: block.hash
    };
    const totalSupply = state.totalSupply + expectedReward;
    const nextState = {
        height: block.height,
        tipHash: block.hash,
        genesisHash: state.genesisHash,
        timestamp: block.timestamp,
        target: calculateNextTarget(state, block.height, block.timestamp),
        cumulativeWork: state.cumulativeWork + blockWork(expectedTarget),
        totalSupply,
        balanceTotal: totalSupply,
        miningIssued: state.miningIssued + expectedReward,
        balances,
        nonces,
        blocks: [...state.blocks, normalizedBlock],
        consensus: state.consensus
    };
    assertValidState(nextState);
    return nextState;
}

function prepareBlock(state, minerAddress, timestamp, transactions, nonce) {
    return {
        height: state.height + 1,
        previousHash: state.tipHash,
        timestamp,
        nonce: nonce.toString(),
        minerAddress,
        reward: calculateBlockReward(state.height + 1, state.miningIssued).toString(),
        target: state.target.toString(),
        transactions
    };
}

function mineBlock(state, minerAddress, timestamp, transactions = [], startNonce = 0n) {
    assertValidState(state);
    const miner = normalizeAddress(minerAddress);
    if (!Number.isSafeInteger(timestamp) || timestamp <= state.timestamp
        || !Array.isArray(transactions) || typeof startNonce !== "bigint" || startNonce < 0n) {
        throw new Error("Invalid MEDAC mining arguments");
    }
    const normalizedTransactions = transactions.map(normalizeTransaction);
    for (let nonce = startNonce; nonce <= BigInt(Number.MAX_SAFE_INTEGER); nonce += 1n) {
        const block = prepareBlock(state, miner, timestamp, normalizedTransactions, nonce);
        block.hash = hashBlockHeader(block, state.genesisHash);
        if (BigInt(`0x${block.hash}`) <= state.target) {
            return { block, state: applyMinedBlock(state, block) };
        }
    }
    throw new Error("MEDAC proof-of-work nonce exhausted");
}

async function mineBlockAsync(state, minerAddress, timestamp, transactions = [], options = {}) {
    assertValidState(state);
    const miner = normalizeAddress(minerAddress);
    if (!Number.isSafeInteger(timestamp) || timestamp <= state.timestamp || !Array.isArray(transactions)) {
        throw new Error("Invalid MEDAC mining arguments");
    }
    const batchSize = options.batchSize === undefined ? 5_000 : options.batchSize;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000_000) {
        throw new RangeError("Invalid MEDAC mining batch size");
    }
    const normalizedTransactions = transactions.map(normalizeTransaction);
    const shouldCancel = options.shouldCancel || (() => false);
    let nonce = options.startNonce === undefined ? 0n : BigInt(options.startNonce);
    if (nonce < 0n) throw new RangeError("Invalid MEDAC proof-of-work nonce");
    while (nonce <= BigInt(Number.MAX_SAFE_INTEGER)) {
        if (shouldCancel()) throw new Error("MEDAC mining cancelled");
        const end = nonce + BigInt(batchSize);
        for (; nonce < end && nonce <= BigInt(Number.MAX_SAFE_INTEGER); nonce += 1n) {
            const block = prepareBlock(state, miner, timestamp, normalizedTransactions, nonce);
            block.hash = hashBlockHeader(block, state.genesisHash);
            if (BigInt(`0x${block.hash}`) <= state.target) {
                return { block, state: applyMinedBlock(state, block) };
            }
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("MEDAC proof-of-work nonce exhausted");
}

module.exports = Object.freeze({
    NETWORK_ID,
    TOKEN,
    TOTAL_SUPPLY,
    GENESIS_SUPPLY,
    MINING_RESERVE,
    HALVING_INTERVAL,
    INITIAL_BLOCK_REWARD,
    MAX_HASH,
    DEFAULT_INITIAL_TARGET,
    DEFAULT_MAX_TARGET,
    TARGET_BLOCK_TIME,
    RETARGET_WINDOW,
    MAX_TRANSACTIONS_PER_BLOCK,
    MIN_TRANSACTION_FEE,
    GENESIS_ALLOCATIONS,
    normalizeAddress,
    calculateBlockReward,
    createGenesisState,
    transactionSigningPayload,
    transactionId,
    normalizeTransaction,
    validateTransactionSequence,
    blockWork,
    calculateNextTarget,
    applyMinedBlock,
    mineBlock,
    mineBlockAsync
});
