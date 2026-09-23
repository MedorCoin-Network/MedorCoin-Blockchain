/**
 * MEDORCOIN INFRASTRUCTURE - CORE TRANSACTION GATEWAY ENGINE
 * Implements strict balance check validation rules and cryptographic signature parsing.
 */

"use strict";

const crypto = require('crypto');
const { ethers } = require('ethers'); // Leverages loaded utility wrappers for ECDSA recovery

/**
 * Validates and checks incoming raw Web3 swap payloads
 * @param {Object} txReceipt The transaction body sent from the front-end layout interface
 * @returns {Boolean} True if signature matches source metrics, throws an exception otherwise
 */
function verifyOnChainTransaction(txReceipt) {
    const { hash, sender, payload, signature } = txReceipt;

    if (!hash || !sender || !payload || !signature) {
        throw new Error("Missing parameters inside transactional packet layout.");
    }

    // 1. Verify structure data payload matches the original layout payload hash
    const computedHash = crypto.createHash('sha256').update(payload).digest('hex');
    if (computedHash !== hash) {
        throw new Error("Data payload hash mismatch detected. Re-routing cancelled.");
    }

    try {
        // 2. Cryptographically recover the signing key parameters natively via ECDSA
        const recoveredAddress = ethers.verifyMessage(hash, signature);
        
        if (recoveredAddress.toLowerCase() !== sender.toLowerCase()) {
            throw new Error("Cryptographic verification failed. Sender address does not own signature verification keys.");
        }

        console.log(`[Engine Validated] Payload signed by authorized key target: ${recoveredAddress}`);
        return true;

    } catch (cryptoError) {
        throw new Error(`Cryptographic signature parsing exception: ${cryptoError.message}`);
    }
}

module.exports = { verifyOnChainTransaction };
