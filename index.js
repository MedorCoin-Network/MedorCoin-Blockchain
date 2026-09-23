require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve all frontend assets natively from this location
app.use(express.static(path.join(__dirname)));

// Root landing page logic maps to your main dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. JSON-RPC Network Route Endpoint for Web3 Wallets
app.post('/api/v1/rpc', (req, res) => {
    const { jsonrpc, method, params, id } = req.body;
    
    // Log internal network engine calls for developer visibility
    console.log(`[JSON-RPC Request] Method: ${method} | ID: ${id}`);

    // Standard EVM Node Response Simulation for Chain Identification
    if (method === 'eth_chainId') {
        return res.json({
            jsonrpc: "2.0",
            id: id,
            result: "0xac5" // Hexadecimal for Chain ID 2757
        });
    }

    if (method === 'net_version') {
        return res.json({
            jsonrpc: "2.0",
            id: id,
            result: "2757"
        });
    }

    // Fallback response for other common block parsing endpoints
    return res.json({
        jsonrpc: "2.0",
        id: id,
        result: "0x0"
    });
});

// 2. Gateway API for Custom App Core Form Interactions
app.post('/api/v1/transaction', (req, res) => {
    console.log("📝 Gateway transactional payload received:", req.body);
    res.status(200).json({ success: true, status: "COMMITTED_TO_MEMPOOL" });
});

app.listen(PORT, () => {
    console.log(`=================================================================`);
    console.log(`🚀 MEDORCOIN ACTIVE RPC INTERFACE IS RUNNING ON PORT ${PORT}`);
    console.log(`=================================================================`);
});
