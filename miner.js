const { ethers } = require("ethers");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const os = require("os");

// ── CONFIG ──────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/-XopPlJnvKjXvCWk0ZISG";
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";

const WALLETS = [
  { address: "0xb6aDCA24b2863b020Fc7A557BD7D03f37b17fd8B", privateKey: process.env.PK_1 }, // MAIN
  { address: "0xb854d024304ff23b907551e1fa9e4c7cdb2cf380", privateKey: process.env.PK_2 },
  { address: "0xad31851a46d00e2b49f05f9eb63f8bd61b00a21d", privateKey: process.env.PK_3 },
  { address: "0xec3c406217c59ab659ab5b089ba17e78cec3e63e", privateKey: process.env.PK_4 },
  { address: "0xbb9c6a8108ca06f1bad5eb22dc12a03ee52e1c34", privateKey: process.env.PK_5 },
  { address: "0x2491b9ba4a6aba33af033a6e77b87c9f02c0cf70", privateKey: process.env.PK_6 },
];

// Minimal ABI — read challenge, difficulty, submit mine
const ABI = [
  "function challenge() view returns (bytes32)",
  "function difficulty() view returns (uint256)",
  "function currentEpoch() view returns (uint256)",
  "function mine(bytes32 nonce) external",
  "function getChallenge(address miner) view returns (bytes32)",
];

const THREADS = Math.max(2, os.cpus().length - 1);
// ────────────────────────────────────────────────────────

// ── WORKER THREAD: pure mining loop ─────────────────────
if (!isMainThread) {
  const { challenge, difficulty, walletAddress, threadId, totalThreads } = workerData;

  const challengeBytes = Buffer.from(challenge.slice(2), "hex");
  const diffBigInt = BigInt(difficulty);
  const addrBytes = Buffer.from(walletAddress.slice(2).toLowerCase(), "hex");

  let nonce = BigInt(threadId) * (BigInt(2) ** BigInt(200) / BigInt(totalThreads));
  let tries = 0n;
  const BATCH = 50000n;

  while (true) {
    for (let i = 0n; i < BATCH; i++) {
      const nonceBytes = Buffer.alloc(32);
      let n = nonce + i;
      for (let b = 31; b >= 0; b--) {
        nonceBytes[b] = Number(n & 0xffn);
        n >>= 8n;
      }

      // keccak256(challenge || walletAddress || nonce)
      const input = Buffer.concat([challengeBytes, addrBytes, nonceBytes]);
      const hash = ethers.keccak256(input);
      const hashBig = BigInt(hash);

      if (hashBig < diffBigInt) {
        parentPort.postMessage({
          found: true,
          nonce: "0x" + (nonce + i).toString(16).padStart(64, "0"),
          hash,
          threadId,
        });
        return;
      }
    }

    tries += BATCH;
    nonce += BATCH;

    parentPort.postMessage({
      found: false,
      tries: Number(tries),
      threadId,
      hashrate: Number(tries),
    });
  }
}

// ── MAIN THREAD ──────────────────────────────────────────
async function mineForWallet(wallet, walletIndex) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(wallet.privateKey, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

  console.log(`\n[Wallet ${walletIndex + 1}] ${wallet.address}`);
  console.log(`[Wallet ${walletIndex + 1}] Starting with ${THREADS} threads...`);

  while (true) {
    try {
      // Fetch current challenge and difficulty
      let challenge, difficulty;
      try {
        challenge = await contract.getChallenge(wallet.address);
      } catch {
        challenge = await contract.challenge();
      }
      difficulty = await contract.difficulty();

      console.log(`[Wallet ${walletIndex + 1}] Challenge: ${challenge.slice(0, 10)}...`);
      console.log(`[Wallet ${walletIndex + 1}] Difficulty: ${difficulty.toString().slice(0, 10)}...`);
      console.log(`[Wallet ${walletIndex + 1}] Mining with ${THREADS} threads...`);

      // Spawn worker threads
      const result = await new Promise((resolve) => {
        let totalTries = 0;
        let startTime = Date.now();
        const workers = [];

        for (let t = 0; t < THREADS; t++) {
          const worker = new Worker(__filename, {
            workerData: {
              challenge,
              difficulty: difficulty.toString(),
              walletAddress: wallet.address,
              threadId: t,
              totalThreads: THREADS,
            },
          });

          workers.push(worker);

          worker.on("message", (msg) => {
            if (msg.found) {
              workers.forEach((w) => w.terminate());
              resolve(msg);
            } else {
              totalTries += msg.tries;
              const elapsed = (Date.now() - startTime) / 1000;
              const mhs = (totalTries / elapsed / 1_000_000).toFixed(2);
              process.stdout.write(
                `\r[Wallet ${walletIndex + 1}] ${mhs} MH/s | ${(totalTries / 1_000_000).toFixed(1)}M hashes`
              );
            }
          });

          worker.on("error", (err) => console.error(`Worker error: ${err.message}`));
        }
      });

      console.log(`\n[Wallet ${walletIndex + 1}] ✅ SOLUTION FOUND! Nonce: ${result.nonce}`);
      console.log(`[Wallet ${walletIndex + 1}] Submitting transaction...`);

      // Submit solution
      try {
        const tx = await contract.mine(result.nonce, {
          gasLimit: 200000,
          maxFeePerGas: ethers.parseUnits("20", "gwei"),
          maxPriorityFeePerGas: ethers.parseUnits("2", "gwei"),
        });
        console.log(`[Wallet ${walletIndex + 1}] TX sent: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
          console.log(`[Wallet ${walletIndex + 1}] 🎉 100 HASH MINED! Block: ${receipt.blockNumber}`);
        } else {
          console.log(`[Wallet ${walletIndex + 1}] ❌ TX failed — epoch likely rotated. Retrying...`);
        }
      } catch (err) {
        console.log(`[Wallet ${walletIndex + 1}] ❌ Submit error: ${err.message}`);
      }

      // Small delay before next round
      await new Promise((r) => setTimeout(r, 3000));

    } catch (err) {
      console.error(`[Wallet ${walletIndex + 1}] Error: ${err.message}`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

async function main() {
  console.log("=".repeat(50));
  console.log("  HASH256 MINER — 5 Wallets | Auto-submit");
  console.log("=".repeat(50));
  console.log(`CPU Threads: ${THREADS}`);
  console.log(`Wallets: ${WALLETS.length}`);
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log("=".repeat(50));

  // Check private keys
  const activeWallets = WALLETS.filter((w) => w.privateKey);
  if (activeWallets.length === 0) {
    console.error("❌ No private keys found! Set PK_1 through PK_5 as environment variables.");
    process.exit(1);
  }

  console.log(`Active wallets: ${activeWallets.length}`);

  // Mine all wallets simultaneously
  await Promise.all(activeWallets.map((wallet, i) => mineForWallet(wallet, i)));
}

main().catch(console.error);
