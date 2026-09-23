/**
 * MEDORCOIN AUTH SERVICE - PRODUCTION HARDENED
 * Features: Argon2 Hashing, JWT Sessions, Redis Cluster Persistence
 */

const { ethers } = require('ethers');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

class AuthService {
    constructor(engine) {
        this.engine = engine;
        // Secure Initialization: Force termination if secret configuration is missing
        if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'emergency_medor_secret_99') {
            throw new Error("FATAL CONFIGURATION ERROR: A robust, non-default JWT_SECRET environment variable must be specified.");
        }
        this.JWT_SECRET = process.env.JWT_SECRET;
    }

    // --- SECURE SIGNUP ---
    async signup(username, password) {
        // Strict Variable Type Guarding (Stops validation bypass injection)
        if (typeof username !== 'string' || typeof password !== 'string') {
            throw new Error("Invalid credential input types");
        }

        const cleanUsername = username.trim();
        if (!cleanUsername || password.length < 12) {
            throw new Error("Username required and password must meet minimum length criteria");
        }

        // 1. Check if user already exists to prevent duplicates
        const existing = await this.engine.redis.get(`auth:${cleanUsername}`);
        if (existing) throw new Error("Username already taken");

        // 2. Generate BIP-39 Wallet Infrastructure
        const wallet = ethers.Wallet.createRandom();
        
        // 3. Argon2id Hashing Execution Layer
        const passwordHash = await argon2.hash(password, {
            type: argon2.argon2id,
            memoryCost: 2 ** 16, // 64MB
            timeCost: 3          // 3 iterations
        });

        // 4. Secure Profile Generation: Encrypt Mnemonic before persistence
        // The master server encrypts seed strings using a derived application key vector
        const rawMnemonic = wallet.mnemonic.phrase;
        const encryptionKey = crypto.scryptSync(this.JWT_SECRET, 'medor_salt_vector', 32);
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);
        let encryptedMnemonic = cipher.update(rawMnemonic, 'utf8', 'hex');
        encryptedMnemonic += cipher.final('hex');

        const userData = {
            username: cleanUsername,
            address: wallet.address,
            encryptedSeed: encryptedMnemonic,
            seedVector: iv.toString('hex'), // IV storage required for local decryption routing
            createdAt: Date.now()
        };

        const authMapping = { 
            hash: passwordHash, 
            address: wallet.address 
        };

        // 5. Store Profile & Auth Mapping in Redis Cluster
        await this.engine.redis.set(`u:${wallet.address}`, JSON.stringify(userData));
        await this.engine.redis.set(`auth:${cleanUsername}`, JSON.stringify(authMapping));
        
        // Return clear parameters + the transient single-exposure mnemonic to the user view
        return {
            username: cleanUsername,
            address: wallet.address,
            mnemonic: rawMnemonic, // Passed once over runtime network response; never saved unencrypted
            createdAt: userData.createdAt
        };
    }

    // --- SECURE LOGIN & JWT ISSUANCE ---
    async login(username, password, ip = 'unknown') {
        if (typeof username !== 'string' || typeof password !== 'string') {
            throw new Error("Authentication failed");
        }
        
        const cleanUsername = username.trim();

        // 1. Hardened Rate Limiting Check using a explicit TTL circuit breaker
        const attemptsKey = `login_attempts:${cleanUsername}`;
        const attempts = await this.engine.redis.incr(attemptsKey);
        
        if (attempts === 1) {
            await this.engine.redis.expire(attemptsKey, 600); // 10 min window set immediately on first fail
        }

        if (attempts > 5) {
            throw new Error("Too many attempts. Account locked for 10 minutes.");
        }

        const authData = await this.engine.redis.get(`auth:${cleanUsername}`);
        if (!authData) {
            // Mitigate standard timing analysis vectors by running an isolated baseline check
            await argon2.hash("dummy_mitigation_password_string_evaluation", { type: argon2.argon2id });
            throw new Error("Authentication failed");
        }

        const auth = JSON.parse(authData);
        
        // 2. Verify Argon2 Hash using strict parameter validation bounds
        const valid = await argon2.verify(auth.hash, password);
        if (!valid) throw new Error("Authentication failed");

        // 3. Reset failed attempts on success
        await this.engine.redis.del(attemptsKey);

        // 4. Issue Signed JWT (Stateless & Revocable)
        const token = jwt.sign(
            { wallet: auth.address, username: cleanUsername, role: 'miner' },
            this.JWT_SECRET,
            { expiresIn: '24h', algorithm: 'HS256' } // Explicit algorithm declaration to prevent algorithm-downgrade flags
        );

        // 5. Store session metadata for auditing/revocation
        const sessionMeta = {
            token,
            ip: typeof ip === 'string' ? ip.replace(/[^\w.:-]/g, '') : 'unknown', // Sanitize IP strings from header injection attempts
            lastSeen: Date.now()
        };
        await this.engine.redis.set(`session:${auth.address}`, JSON.stringify(sessionMeta), 'EX', 86400);
        
        return { token, address: auth.address };
    }

    // --- SESSION VALIDATION ---
    async verifySession(token) {
        if (typeof token !== 'string') return null;
        try {
            const decoded = jwt.verify(token, this.JWT_SECRET, { algorithms: ['HS256'] });
            
            // Check Redis database cache to ensure the token identifier hasn't been blacklisted/dropped
            const active = await this.engine.redis.exists(`session:${decoded.wallet}`);
            if (!active) return null;
            
            return decoded;
        } catch (e) {
            return null;
        }
    }
}

module.exports = AuthService;
