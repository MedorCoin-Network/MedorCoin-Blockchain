require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve all your frontend HTML/JS files from this directory
app.use(express.static(path.join(__dirname)));

// Root route loads your homepage dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Mock endpoint for your swap transactions
app.post('/api/v1/transaction', (req, res) => {
    console.log("📝 Incoming trade request payload received:", req.body);
    res.status(200).json({ success: true, status: "COMMITTED_TO_MEMPOOL" });
});

app.listen(PORT, () => {
    console.log(`=================================================================`);
    console.log(`🚀 MEDORCOIN BACKEND NODE RUNNING SECURELY ON PORT ${PORT}`);
    console.log(`=================================================================`);
});
