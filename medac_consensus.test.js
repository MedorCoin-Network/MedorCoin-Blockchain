const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Wallet } = require('ethers');
const consensus = require('./medac_consensus.cjs');
const { MedacChain } = require('./medac_chain.cjs');
const { MedacNode } = require('./medac_node.cjs');

const MINER = '0x1111111111111111111111111111111111111111';
const TEST_CONSENSUS = {
  initialTarget: (consensus.MAX_HASH >> 8n).toString(),
  maxTarget: (consensus.MAX_HASH >> 4n).toString(),
  targetBlockTime: 60,
  retargetWindow: 4,
};
const TEST_WALLET = new Wallet(`0x${'1'.repeat(64)}`);

function makeFundedState() {
  const state = consensus.createGenesisState(TEST_CONSENSUS);
  const funder = consensus.GENESIS_ALLOCATIONS[0].address.toLowerCase();
  const amount = 10n * consensus.TOKEN;
  state.balances.set(funder, state.balances.get(funder) - amount);
  state.balances.set(TEST_WALLET.address.toLowerCase(), amount);
  return state;
}

async function signedTransaction(wallet, fields, genesisHash) {
  const transaction = {
    from: wallet.address.toLowerCase(),
    genesisHash,
    ...fields,
  };
  transaction.signature = await wallet.signMessage(consensus.transactionSigningPayload(transaction));
  return transaction;
}

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'medac-node-'));
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for MEDAC peer synchronization');
}

test('genesis creates only the three agreed allocations and leaves mining unissued', () => {
  const state = consensus.createGenesisState(TEST_CONSENSUS);
  const genesisTotal = consensus.GENESIS_ALLOCATIONS.reduce(
    (sum, allocation) => sum + allocation.amount, 0n
  );

  assert.equal(genesisTotal, consensus.GENESIS_SUPPLY);
  assert.equal(state.totalSupply, consensus.GENESIS_SUPPLY);
  assert.equal(state.miningIssued, 0n);
  assert.equal(state.balances.size, 3);
  assert.equal(state.balances.has(MINER), false);
});

test('subsidy halves on schedule and cannot spend the reserve in the first era', () => {
  const firstEraReward = consensus.INITIAL_BLOCK_REWARD;
  assert.equal(firstEraReward, 116_666_666_666_666_666_684n);
  assert.equal(consensus.calculateBlockReward(1, 0n), firstEraReward);
  assert.equal(
    consensus.calculateBlockReward(consensus.HALVING_INTERVAL, 0n),
    firstEraReward
  );
  assert.equal(
    consensus.calculateBlockReward(consensus.HALVING_INTERVAL + 1, 0n),
    firstEraReward >> 1n
  );
  assert.equal(
    firstEraReward * BigInt(consensus.HALVING_INTERVAL),
    35_000_000_000_000_000_005_200_000n
  );
  assert.ok(firstEraReward * BigInt(consensus.HALVING_INTERVAL) < consensus.MINING_RESERVE);
});

test('full halving schedule reaches reserve only through bounded block rewards', () => {
  let issued = 0n;
  let height = 1;
  let finalReward = 0n;

  while (issued < consensus.MINING_RESERVE) {
    finalReward = consensus.calculateBlockReward(height, issued);
    assert.ok(finalReward > 0n);
    const halvings = Math.floor((height - 1) / consensus.HALVING_INTERVAL);
    const scheduled = consensus.INITIAL_BLOCK_REWARD >> BigInt(halvings);
    assert.ok(finalReward <= scheduled);
    issued += finalReward;
    height += 1;
  }

  assert.equal(issued, consensus.MINING_RESERVE);
  assert.equal(height - 1, 19_733_334);
  assert.equal(finalReward, 1n);
  assert.ok(finalReward < consensus.INITIAL_BLOCK_REWARD);
  assert.equal(consensus.calculateBlockReward(1, consensus.MINING_RESERVE), 0n);
});

test('valid proof of work credits only that block reward and preserves prior state', () => {
  const before = consensus.createGenesisState(TEST_CONSENSUS);
  const result = consensus.mineBlock(before, MINER, 1_000);

  assert.equal(before.height, 0);
  assert.equal(before.totalSupply, consensus.GENESIS_SUPPLY);
  assert.equal(result.state.height, 1);
  assert.equal(result.state.miningIssued, consensus.INITIAL_BLOCK_REWARD);
  assert.equal(result.state.totalSupply, consensus.GENESIS_SUPPLY + consensus.INITIAL_BLOCK_REWARD);
  assert.equal(result.state.balances.get(MINER), consensus.INITIAL_BLOCK_REWARD);
});

test('adaptive target tightens when blocks arrive faster than target time', () => {
  let state = consensus.createGenesisState(TEST_CONSENSUS);
  const initialTarget = state.target;
  for (let height = 1; height <= TEST_CONSENSUS.retargetWindow; height += 1) {
    state = consensus.mineBlock(state, MINER, 1_000 + height, []).state;
  }
  assert.ok(state.target < initialTarget);
  assert.ok(state.target >= 1n);
});

test('signed transfers enforce sender, nonce, balance, and miner fee accounting', async () => {
  const state = makeFundedState();
  const recipient = '0x2222222222222222222222222222222222222222';
  const transaction = await signedTransaction(TEST_WALLET, {
    to: recipient,
    nonce: 0,
    amount: consensus.TOKEN.toString(),
    fee: consensus.MIN_TRANSACTION_FEE.toString(),
  }, state.genesisHash);
  const result = consensus.mineBlock(state, MINER, 1_000, [transaction]);

  assert.equal(result.state.balances.get(recipient), consensus.TOKEN);
  assert.equal(result.state.nonces.get(TEST_WALLET.address.toLowerCase()), 1);
  assert.equal(result.state.balances.get(MINER), consensus.INITIAL_BLOCK_REWARD + consensus.MIN_TRANSACTION_FEE);
  assert.equal(result.state.totalSupply, state.totalSupply + consensus.INITIAL_BLOCK_REWARD);
  assert.throws(() => consensus.mineBlock(state, MINER, 1_001, [{ ...transaction, amount: '2' }]));

  const otherNetwork = consensus.createGenesisState({
    ...TEST_CONSENSUS,
    initialTarget: (consensus.MAX_HASH >> 7n).toString(),
  });
  assert.throws(() => consensus.validateTransactionSequence(otherNetwork, [transaction]), /another genesis network/);
});

test('rejects forged rewards, altered proof of work, and inconsistent state', () => {
  const state = consensus.createGenesisState(TEST_CONSENSUS);
  const { block } = consensus.mineBlock(state, MINER, 1_000);

  assert.throws(() => consensus.applyMinedBlock(state, { ...block, reward: '70000000000000000000000000' }));
  assert.throws(() => consensus.applyMinedBlock(state, { ...block, hash: 'f'.repeat(64) }));
  assert.throws(() => consensus.applyMinedBlock({ ...state, totalSupply: consensus.TOTAL_SUPPLY }, block));
  assert.throws(() => consensus.mineBlock(state, MINER, 1, -1n));
});

test('chain adopts only strictly greater cumulative work and reorgs to that branch', async () => {
  const directory = tempDirectory();
  try {
    let chain = new MedacChain({ dataDir: directory, consensus: TEST_CONSENSUS });
    await chain.open();
    const genesis = consensus.createGenesisState(TEST_CONSENSUS);
    const firstBranch = consensus.mineBlock(genesis, MINER, 1_000).block;
    const otherFirst = consensus.mineBlock(genesis, MINER, 1_001).block;
    const otherState = consensus.applyMinedBlock(genesis, otherFirst);
    const otherSecond = consensus.mineBlock(otherState, MINER, 1_002).block;

    await chain.appendBlock(firstBranch);
    assert.equal((await chain.considerChain([otherFirst])).adopted, false);
    const result = await chain.considerChain([otherFirst, otherSecond]);
    assert.equal(result.adopted, true);
    assert.equal(chain.state.tipHash, otherSecond.hash);
    await chain.close();

    chain = new MedacChain({ dataDir: directory, consensus: TEST_CONSENSUS });
    await chain.open();
    assert.equal(chain.state.tipHash, otherSecond.hash);
    assert.equal(chain.state.height, 2);
    await chain.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('persistent chain is replay-validated and corruption fails closed', async () => {
  const directory = tempDirectory();
  try {
    let chain = new MedacChain({ dataDir: directory, consensus: TEST_CONSENSUS });
    await chain.open();
    const block = consensus.mineBlock(chain.state, MINER, 1_000).block;
    await chain.appendBlock(block);
    await chain.close();

    chain = new MedacChain({ dataDir: directory, consensus: TEST_CONSENSUS });
    await chain.open();
    assert.equal(chain.state.tipHash, block.hash);
    await chain.close();

    const storePath = path.join(directory, 'chain.ndjson');
    const lines = fs.readFileSync(storePath, 'utf8').trimEnd().split('\n');
    const record = JSON.parse(lines[1]);
    record.checksum = '0'.repeat(64);
    lines[1] = JSON.stringify(record);
    fs.writeFileSync(storePath, `${lines.join('\n')}\n`);
    chain = new MedacChain({ dataDir: directory, consensus: TEST_CONSENSUS });
    await assert.rejects(chain.open(), /journal checksum validation failed/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('MEDAC peers synchronize a validated higher-work chain', async () => {
  const firstDirectory = tempDirectory();
  const secondDirectory = tempDirectory();
  const first = new MedacNode({ host: '127.0.0.1', port: 0, dataDir: firstDirectory, consensus: TEST_CONSENSUS });
  const second = new MedacNode({
    host: '127.0.0.1',
    port: 0,
    dataDir: secondDirectory,
    consensus: TEST_CONSENSUS,
  });
  try {
    await first.start();
    const block = await first.mine(MINER, { timestamp: 1_000 });
    const address = first.address();
    second.seedPeers.push(`ws://127.0.0.1:${address.port}`);
    await second.start();
    await waitFor(() => second.chain.state.tipHash === block.hash);
    assert.equal(second.chain.state.totalSupply, first.chain.state.totalSupply);
  } finally {
    await second.stop();
    await first.stop();
    fs.rmSync(firstDirectory, { recursive: true, force: true });
    fs.rmSync(secondDirectory, { recursive: true, force: true });
  }
});

test('public listeners require TLS and unencrypted remote peers are rejected', () => {
  assert.throws(() => new MedacNode({ host: '0.0.0.0' }), /TLS key and certificate/);
  assert.doesNotThrow(() => new MedacNode({ host: '0.0.0.0', trustProxyTls: true }));
  const node = new MedacNode();
  assert.throws(() => node.connectTo('ws://example.com:19444'), /loopback/);
});

test('Render-style listener serves health checks over its internal HTTP port', async () => {
  const directory = tempDirectory();
  const node = new MedacNode({
    host: '0.0.0.0',
    port: 0,
    dataDir: directory,
    trustProxyTls: true,
    consensus: TEST_CONSENSUS,
  });
  try {
    await node.start();
    const { port } = node.address();
    const response = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/healthz`, resolve).on('error', reject);
    });
    let body = '';
    for await (const chunk of response) body += chunk;
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(body).genesisHash, node.chain.state.genesisHash);
  } finally {
    await node.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
