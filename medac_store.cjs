"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 512 * 1024 * 1024;
const NETWORK_ID = "MEDAC-POW-1";

function encodeRecord(value) {
    const payload = JSON.stringify(value);
    return `${JSON.stringify({
        payload,
        checksum: crypto.createHash("sha256").update(payload).digest("hex")
    })}\n`;
}

function decodeRecord(line) {
    let envelope;
    try { envelope = JSON.parse(line); } catch { throw new Error("MEDAC journal record is invalid JSON"); }
    if (!envelope || typeof envelope.payload !== "string"
        || typeof envelope.checksum !== "string"
        || !/^[0-9a-f]{64}$/.test(envelope.checksum)
        || crypto.createHash("sha256").update(envelope.payload).digest("hex") !== envelope.checksum) {
        throw new Error("MEDAC journal checksum validation failed");
    }
    try { return JSON.parse(envelope.payload); } catch {
        throw new Error("MEDAC journal payload is invalid JSON");
    }
}

function writeAll(fd, value) {
    const buffer = Buffer.from(value, "utf8");
    let offset = 0;
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
}

class MedacStore {
    constructor(directory) {
        if (typeof directory !== "string" || directory.length === 0) {
            throw new TypeError("MEDAC data directory is required");
        }
        this.directory = path.resolve(directory);
        this.chainPath = path.join(this.directory, "chain.ndjson");
        this.lockPath = path.join(this.directory, "node.lock");
        this.lockFd = null;
        this.chainFd = null;
        this.genesisHash = null;
        this.blocks = [];
    }

    open(genesisHash) {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const directoryStat = fs.lstatSync(this.directory);
        if (!directoryStat.isDirectory() || (typeof process.getuid === "function"
            && directoryStat.uid !== process.getuid()) || (directoryStat.mode & 0o077) !== 0) {
            throw new Error("MEDAC data directory must be owned by this user and private");
        }
        try {
            this.lockFd = fs.openSync(this.lockPath, "wx", 0o600);
            fs.writeSync(this.lockFd, `${process.pid}\n`);
            fs.fsyncSync(this.lockFd);
        } catch (error) {
            if (error.code === "EEXIST") throw new Error("Another MEDAC node holds this data directory");
            throw error;
        }
        this.genesisHash = genesisHash;

        if (!fs.existsSync(this.chainPath)) {
            const header = encodeRecord({
                type: "header",
                version: STORE_VERSION,
                networkId: NETWORK_ID,
                genesisHash
            });
            const fd = fs.openSync(this.chainPath, "wx", 0o600);
            try {
                writeAll(fd, header);
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            this._syncDirectory();
        }

        const stat = fs.lstatSync(this.chainPath);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_STORE_BYTES) {
            throw new Error("MEDAC journal has invalid type, permissions, or size");
        }
        let contents = fs.readFileSync(this.chainPath, "utf8");
        const completeLength = contents.lastIndexOf("\n") + 1;
        if (completeLength !== contents.length) {
            const repairFd = fs.openSync(this.chainPath, "r+");
            try {
                fs.ftruncateSync(repairFd, Buffer.byteLength(contents.slice(0, completeLength)));
                fs.fsyncSync(repairFd);
            } finally {
                fs.closeSync(repairFd);
            }
            contents = contents.slice(0, completeLength);
        }
        const lines = contents.split("\n").filter(Boolean);
        if (lines.length === 0) throw new Error("MEDAC journal is empty");
        const header = decodeRecord(lines[0]);
        if (header.type !== "header" || header.version !== STORE_VERSION
            || header.networkId !== NETWORK_ID || header.genesisHash !== genesisHash) {
            throw new Error("MEDAC journal belongs to another network or schema");
        }
        for (const line of lines.slice(1)) {
            const record = decodeRecord(line);
            if (record.type !== "block" || !record.block || typeof record.block !== "object") {
                throw new Error("MEDAC journal contains an invalid block record");
            }
            this.blocks.push(record.block);
        }
        this.chainFd = fs.openSync(this.chainPath, "a", 0o600);
        return this.blocks.slice();
    }

    append(genesisHash, block) {
        if (this.lockFd === null || this.chainFd === null || genesisHash !== this.genesisHash) {
            throw new Error("MEDAC store is not open for this network");
        }
        const record = encodeRecord({ type: "block", block });
        const start = fs.fstatSync(this.chainFd).size;
        if (start + Buffer.byteLength(record) > MAX_STORE_BYTES) {
            throw new Error("MEDAC journal reached its configured size limit");
        }
        try {
            writeAll(this.chainFd, record);
            fs.fsyncSync(this.chainFd);
            this.blocks.push(block);
        } catch (error) {
            fs.ftruncateSync(this.chainFd, start);
            fs.fsyncSync(this.chainFd);
            throw error;
        }
    }

    replace(genesisHash, blocks) {
        if (this.lockFd === null || genesisHash !== this.genesisHash || !Array.isArray(blocks)) {
            throw new Error("MEDAC store is not open for this network");
        }
        const temporaryPath = `${this.chainPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
        let fd;
        try {
            fd = fs.openSync(temporaryPath, "wx", 0o600);
            writeAll(fd, encodeRecord({
                type: "header",
                version: STORE_VERSION,
                networkId: NETWORK_ID,
                genesisHash
            }));
            for (const block of blocks) {
                writeAll(fd, encodeRecord({ type: "block", block }));
                if (fs.fstatSync(fd).size > MAX_STORE_BYTES) {
                    throw new Error("MEDAC journal exceeds its configured size limit");
                }
            }
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = undefined;
            fs.renameSync(temporaryPath, this.chainPath);
            this._syncDirectory();
            fs.closeSync(this.chainFd);
            this.chainFd = fs.openSync(this.chainPath, "a", 0o600);
            this.blocks = blocks.slice();
        } catch (error) {
            if (fd !== undefined) fs.closeSync(fd);
            try { fs.unlinkSync(temporaryPath); } catch {}
            throw error;
        }
    }

    _syncDirectory() {
        const fd = fs.openSync(this.directory, "r");
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }

    close() {
        if (this.chainFd !== null) {
            fs.closeSync(this.chainFd);
            this.chainFd = null;
        }
        if (this.lockFd === null) return;
        fs.closeSync(this.lockFd);
        this.lockFd = null;
        try { fs.unlinkSync(this.lockPath); } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
}

module.exports = Object.freeze({ MedacStore });
