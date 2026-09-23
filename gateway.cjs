/**
 * FILE: medorcoin-node/gateway.cjs
 * UPDATED INDUSTRIAL BUILD - HARDENED PRODUCTION EDITION
 * Corrected: Standardized CommonJS module constraints and structural Zod exception handling layers.
 */

"use strict";

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');
const { rateLimit } = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default || require('rate-limit-redis');
const Redis = require('ioredis');
const jwt = require('jsonwebtoken');
const { z } = require('zod');

// Local Modules - Standardized CommonJS Import Routing
const { handleRPCRequest } = require("./routes/rpc.cjs");
const logger = require("./utils/logger.cjs");
const Mempool = require("./mempool.cjs");

// Dynamic verification fallback mapping for metrics module formats
let Metrics;
try {
    Metrics = require("./metrics.js");
} catch (e) {
    Metrics = require("./metrics.cjs");
}

// 1. STATEFUL INITIALIZATION
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
const metrics = new Metrics();
metrics.useRedis(redis); // Link Metrics to Redis for persistence
global.mempool = new Mempool(); 

// 2. RPC SCHEMA VALIDATION
const RPCSchema = z.object({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1),
    params: z.array(z.any()).optional(),
    id: z.union([z.string(), z.number()]).nullable()
});

// 3. PRODUCTION RATE LIMITER
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    standardHeaders: true,
    store: new RedisStore({ 
        sendCommand: (...args) => redis.call(...args) 
    }),
});

// 4. TLS CONFIGURATION
const tlsOptions = {
    key: fs.readFileSync(path.resolve(__dirname, './certs/server.key')),
    cert: fs.readFileSync(path.resolve(__dirname, './certs/server.cert')),
    minVersion: 'TLSv1.2',
    ciphers: 'ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256',
    honorCipherOrder: true
};

const server = https.createServer(tlsOptions, (req, res) => {
    const start = performance.now();

    // SECURITY HEADERS
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    res.setHeader('Access-Control-Allow-Origin', 'https://medorcoin.org');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none';");

    // Standardize request wrapper alignment to match express rate limiter callback mapping
    limiter(req, res, () => {
        const { method, url } = req;

        // A. PUBLIC API PROXY
        if (method === 'GET' && url === '/api/stats') {
            return servePublicStats(res);
        }

        // B. SECURE RPC HANDLER
        if (method === 'POST') {
            return processSecureRPC(req, res, start);
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "NOT_FOUND" }));
    });
});

async function servePublicStats(res) {
    try {
        const stats = (await global.mempool.getMiningTemplate()) || { blocks: 0, hashrate: "0" }; 
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ height: stats.blocks, hashrate: stats.hashrate }));
    } catch (err) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Node Busy" }));
    }
}

async function processSecureRPC(req, res, startTime) {
    let body = '';
    req.on('data', chunk => {
        body += chunk;
        if (body.length > 524288) { // 512KB Max Payload enforcement
            req.destroy();
        }
    });

    req.on('end', async () => {
        let rpcReq;
        try {
            if (!body) throw { code: -32700, message: "Parse error: Empty request payload body" };
            rpcReq = JSON.parse(body);
            
            // 1. SCHEMA VALIDATION
            const validated = RPCSchema.parse(rpcReq);

            // 2. JWT & BLACKLIST CONTEXT
            let user = null;
            if (validated.method !== 'medor_login') {
                const authHeader = req.headers.authorization;
                if (!authHeader || !authHeader.startsWith('Bearer ')) {
                    throw { code: -32001, message: "UNAUTHORIZED: TOKEN_MISSING" };
                }
                
                const token = authHeader.split(' ')[1];
                user = jwt.verify(token, process.env.JWT_SECRET);
                
                const isBlacklisted = await redis.get(`blacklist:${user.sub}`);
                if (isBlacklisted) throw { code: -32003, message: "SESSION_REVOKED" };
            }

            // 3. EXECUTE ROUTER (Passes all required context)
            const result = await handleRPCRequest(
                { ...validated, user }, 
                global.mempool, 
                redis, 
                metrics
            );
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: "2.0", result, id: validated.id }));

        } catch (err) {
            let code = err.code || -32603;
            let msg = err.message || "Internal Error";

            // Fixed: Safely extract and flat-map structural ZodError anomalies to prevent stack exposure flags
            if (err instanceof z.ZodError) {
                code = -32602; // Invalid JSON-RPC parameters code standard
                msg = `Invalid parameters: ${err.errors.map(e => `\({e.path.join('.')}:\){e.message}`).join(', ')}`;
            } else if (err instanceof SyntaxError) {
                code = -32700; // Parse error standard
                msg = "Parse error: Malformed JSON payload string structure";
            } else if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
                code = -32001;
                msg = `UNAUTHORIZED: ${err.message.toUpperCase()}`;
            }

            logger.warn("GATEWAY_SEC", `Rejection: ${msg}`);
            
            res.writeHead(code === -32001 ? 401 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                jsonrpc: "2.0", 
                error: { code, message: msg }, 
                id: rpcReq?.id || null 
            }));
        } finally {
            // 4. METRICS RECORDING
            if (rpcReq && typeof rpcReq.method === 'string') {
                metrics.observe("mdc_rpc_latency_ms", performance.now() - startTime, { method: rpcReq.method });
            } else {
                metrics.observe("mdc_rpc_latency_ms", performance.now() - startTime, { method: "unknown" });
            }
        }
    });
}

server.listen(process.env.RPC_PORT || 8332, () => {
    logger.info("SYSTEM", "MedorCoin Industrial Gateway Locked & Online");
});
