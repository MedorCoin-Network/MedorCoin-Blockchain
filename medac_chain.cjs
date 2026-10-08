"use strict";

const consensus = require("./medac_consensus.cjs");
const { MedacStore } = require("./medac_store.cjs");

const MAX_CHAIN_BLOCKS = 2_000_000;

class MedacChain {
    constructor(options = {}) {
        this.consensusOptions = options.consensus || {};
        this.state = consensus.createGenesisState(this.consensusOptions);
        this.store = options.dataDir ? new MedacStore(options.dataDir) : null;
        this.opened = false;
    }

    async open() {
        if (this.opened) return this.state;
        try {
            if (this.store) {
                const blocks = this.store.open(this.state.genesisHash);
                if (blocks.length > MAX_CHAIN_BLOCKS) throw new Error("MEDAC chain exceeds replay limit");
                let state = consensus.createGenesisState(this.consensusOptions);
                for (const block of blocks) state = consensus.applyMinedBlock(state, block);
                this.state = state;
            }
            this.opened = true;
            return this.state;
        } catch (error) {
            if (this.store) this.store.close();
            throw error;
        }
    }

    async close() {
        if (this.store) this.store.close();
        this.opened = false;
    }

    async appendBlock(block) {
        const nextState = consensus.applyMinedBlock(this.state, block);
        if (this.store) this.store.append(nextState.genesisHash, nextState.blocks[nextState.height - 1]);
        this.state = nextState;
        return this.state;
    }

    async considerChain(blocks) {
        if (!Array.isArray(blocks) || blocks.length > MAX_CHAIN_BLOCKS) {
            throw new Error("Invalid MEDAC candidate chain length");
        }
        let candidate = consensus.createGenesisState(this.consensusOptions);
        for (const block of blocks) candidate = consensus.applyMinedBlock(candidate, block);
        if (candidate.cumulativeWork <= this.state.cumulativeWork) {
            return { adopted: false, state: this.state, candidateWork: candidate.cumulativeWork };
        }
        if (this.store) this.store.replace(candidate.genesisHash, candidate.blocks);
        const previousTip = this.state.tipHash;
        this.state = candidate;
        return { adopted: true, state: candidate, previousTip, candidateWork: candidate.cumulativeWork };
    }

    async acceptTransaction(transaction, pendingTransactions = []) {
        const normalized = consensus.normalizeTransaction(transaction);
        consensus.validateTransactionSequence(this.state, [...pendingTransactions, normalized]);
        return normalized;
    }
}

module.exports = Object.freeze({ MedacChain, MAX_CHAIN_BLOCKS });
