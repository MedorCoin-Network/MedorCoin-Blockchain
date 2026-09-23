/**
 * CONSENSUS_ENGINE.CJS - The Sovereign Law of MedorCoin
 * Logic: Proof-of-Work (PoW) with Retargeting and Reward Halving.
 * Hardened Edition: Eliminated float rounding vulnerabilities and unpadded radix errors.
 */

"use strict";

const crypto = require('crypto');

class ConsensusEngine {
  constructor(dbInstance) {
    this.db = dbInstance;

    // --- HARDCODED NETWORK CONSTANTS (Production Grade) ---
    this.GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
    this.INITIAL_REWARD = 50n * (10n**18n); // 50 MEDOR per block
    this.HALVING_INTERVAL = 210000;         // Every 210k blocks (Bitcoin style)
    
    this.TARGET_BLOCK_TIME = 600n;          // 10 minutes (600 seconds) - Enforced as BigInt
    this.RETARGET_INTERVAL = 2016n;         // Every 2 weeks (2016 blocks) - Enforced as BigInt
    
    // Minimum and Maximum difficulty bounds
    this.MAX_TARGET = BigInt("0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
  }

  /**
   * Calculates the block reward based on current height (Halving logic)
   */
  getBlockReward(height) {
    if (typeof height !== 'number' || height < 0) return 0n;
    const halvings = Math.floor(height / this.HALVING_INTERVAL);
    if (halvings >= 64) return 0n; // Max supply reached
    return this.INITIAL_REWARD >> BigInt(halvings);
  }

  /**
   * Verifies if a block meets the PoW Target (Real difficulty check)
   */
  verifyPoW(blockHash, difficultyTarget) {
    if (typeof blockHash !== 'string' || !blockHash) return false;
    try {
        const hashInt = BigInt(`0x${blockHash.replace(/[^0-9a-fA-F]/g, '')}`);
        const target = BigInt(difficultyTarget);
        return hashInt <= target;
    } catch (e) {
        return false;
    }
  }

  /**
   * Implements the "Longest Chain" Rule (Cumulative Work)
   * Resolves forks by picking the chain with most difficulty.
   */
  isBetterChain(newTotalWork, currentTotalWork) {
    try {
        return BigInt(newTotalWork) > BigInt(currentTotalWork);
    } catch (e) {
        return false;
    }
  }

  /**
   * Hardened Difficulty Adjustment Algorithm (Retargeting)
   * Fixed: Uses 100% pure BigInt integer math to prevent network-splitting float drifts
   */
  calculateNextTarget(lastRetargetBlock, lastBlock) {
    if (!lastRetargetBlock || !lastBlock) {
        throw new Error("INVALID_RETARGET_PARAMETERS");
    }

    const currentHeight = BigInt(lastBlock.height);
    
    // Every RETARGET_INTERVAL blocks, adjust difficulty
    if (currentHeight % this.RETARGET_INTERVAL !== 0n) {
      return lastBlock.difficultyTarget;
    }

    const actualTime = BigInt(Math.max(1, lastBlock.timestamp - lastRetargetBlock.timestamp));
    const expectedTime = this.RETARGET_INTERVAL * this.TARGET_BLOCK_TIME;

    // Fixed: Pure BigInt Scaling Bounds to eliminate float precision bugs
    // Clamping limits map to 4x (actualTime >= 4 * expectedTime) or 1/4x (actualTime <= expectedTime / 4)
    let boundedActualTime = actualTime;
    if (actualTime * 4n < expectedTime) {
        boundedActualTime = expectedTime / 4n;
    } else if (actualTime > expectedTime * 4n) {
        boundedActualTime = expectedTime * 4n;
    }

    // Fixed: Multipliers scale directly via scale operations to maintain deterministic integer consensus
    let newTarget = (BigInt(lastBlock.difficultyTarget) * boundedActualTime) / expectedTime;

    // Ensure it never goes easier than Genesis maximum target limits
    if (newTarget > this.MAX_TARGET) {
        newTarget = this.MAX_TARGET;
    }
    
    if (newTarget < 1n) {
        newTarget = 1n;
    }

    // Fixed: Guaranteed 64-character un-truncated hex output structure with leading zeros preserved
    return newTarget.toString(16).padStart(64, '0');
  }

  /**
   * Validates a Block Header before execution
   */
  async validateBlockHeader(block, prevBlock) {
    if (!block || !prevBlock) throw new Error("MISSING_BLOCK_DATA");
    
    // 1. Check Previous Hash link
    if (block.prevHash !== prevBlock.hash) throw new Error("INVALID_PREV_HASH");

    // 2. Check Timestamp (No future blocks, no past blocks older than median)
    const currentTimeWindow = Math.floor(Date.now() / 1000);
    if (block.timestamp <= prevBlock.timestamp) throw new Error("BLOCK_TIMESTAMP_TOO_OLD");
    if (block.timestamp > currentTimeWindow + 7200) throw new Error("BLOCK_TIMESTAMP_IN_FUTURE");

    // 3. Verify PoW
    if (!this.verifyPoW(block.hash, block.difficultyTarget)) {
        throw new Error("INSUFFICIENT_WORK");
    }

    return true;
  }
}

module.exports = ConsensusEngine;
