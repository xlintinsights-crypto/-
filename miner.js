const { ethers } = require("ethers");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const os = require("os");

// ── CONFIG ──────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const CHAIN_ID = 1n;

const WALLETS = [
  { address: "0xb6aDCA24b2863b020Fc7A557BD7D03f37b17fd8B", privateKey: process.env.PK_1 },
  { address: "0xb854d024304ff23b907551e1fa9e4c7cdb2cf380", privateKey: process.env.PK_2 },
  { address: "0xad31851a46d00e2b49f05f9eb63f8bd61b00a21d", privateKey: process.env.PK_3 },
  { address: "0xec3c406217c59ab659ab5b089ba17e78cec3e63e", privateKey: process.env.PK_4 },
  { address: "0xbb9c6a8108ca06f1bad5eb22dc12a03ee52e1c34", privateKey: process.env.PK_5 },
  { address: "0x2491b9ba4a6aba33af033a6e77b87c9f02c0cf70", privateKey: process.env.PK_6 },
];

const ABI = [
  "function epoch() view returns (uint256)",
  "function difficulty() view returns (uint256)",
  "function mine(bytes32 nonce) external",
];

const THREADS = Math.max(2, os.cpus().length - 1);
// ────────────────────────────────────────────────────────

if (!isMainThread) {
  const { challenge, difficulty, threadId, totalThreads } = workerData;
  const challengeBytes = Buffer.from(challenge.slice(2), "hex");
  const diffBigInt = BigInt(difficulty);
  let nonce = BigInt(threadId) * (BigInt(2) ** BigInt(248) / BigInt(totalThreads));
  const BATCH = 100000n;

  while (true) {
    let tries = 0n;
    for (let i = 0n; i < BATCH; i++) {
      const nonceBytes = Buffer.alloc(32);
      let n = nonce + i;
      for (let b = 31; b >= 0; b--) {
        nonceBytes[b] = Number(n & 0xffn);
        n >>= 8n;
      }
      const hash = ethers.keccak256(Buffer.concat([challengeBytes, nonceBytes]));
      if (BigInt(hash) < diffBigInt) {
        parentPort.postMessage({ found: true, nonce: "0x" + (nonce + i).toString(16).padStart(64, "0") });
        return;
      }
      tries++;
    }
    nonce += BATCH;
    parentPort.postMessage({ found: false, tries: Number(BATCH) });
  }
}

function computeChallenge(walletAddress, epoch) {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["uint256", "address", "address", "uint256"],
      [CHAIN_ID, CONTRACT_ADDRESS, walletAddress, epoch]
    )
  );
}

async function mineForWallet(wallet, idx) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(wallet.privateKey, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

  console.log(`\n[W${idx + 1}] ${wallet.address} | ${THREADS} threads`);

  while (true) {
    try {
      const [epoch, difficulty] = await Promise.all([contract.epoch(), contract.difficulty()]);
      const challenge = computeChallenge(wallet.address, epoch);

      console.log(`\n[W${idx + 1}] Epoch: ${epoch} | Mining...`);

      const startTime = Date.now();
      let totalTries = 0;

      const result = await new Promise((resolve, reject) => {
        const workers = [];
        const epochTimer = setTimeout(() => {
          workers.forEach((w) => w.terminate());
          resolve({ epochRotated: true });
        }, 120000);

        for (let t = 0; t < THREADS; t++) {
          const w = new Worker(__filename, {
            workerData: { challenge, difficulty: difficulty.toString(), threadId: t, totalThreads: THREADS },
          });
          workers.push(w);
          w.on("message", (msg) => {
            if (msg.found) {
              clearTimeout(epochTimer);
              workers.forEach((x) => x.terminate());
              resolve(msg);
            } else {
              totalTries += msg.tries;
              const mhs = (totalTries / ((Date.now() - startTime) / 1000) / 1e6).toFixed(2);
              process.stdout.write(`\r[W${idx + 1}] ${mhs} MH/s | ${(totalTries / 1e6).toFixed(1)}M hashes`);
            }
          });
          w.on("error", reject);
        }
      });

      if (result.epochRotated) {
        console.log(`\n[W${idx + 1}] Epoch rotated — refreshing...`);
        continue;
      }

      console.log(`\n[W${idx + 1}] ✅ FOUND! Submitting...`);
      try {
        const tx = await contract.mine(result.nonce, {
          gasLimit: 200000,
          maxFeePerGas: ethers.parseUnits("20", "gwei"),
          maxPriorityFeePerGas: ethers.parseUnits("2", "gwei"),
        });
        const receipt = await tx.wait();
        console.log(receipt.status === 1
          ? `[W${idx + 1}] 🎉 100 HASH MINED! TX: ${tx.hash}`
          : `[W${idx + 1}] ❌ TX reverted — retrying...`
        );
      } catch (e) {
        console.log(`[W${idx + 1}] ❌ ${e.message.slice(0, 80)}`);
      }

      await new Promise((r) => setTimeout(r, 3000));
    } catch (e) {
      console.error(`[W${idx + 1}] Error: ${e.message.slice(0, 100)}`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

async function main() {
  if (!RPC_URL) { console.error("❌ RPC_URL not set!"); process.exit(1); }
  const active = WALLETS.filter((w) => w.privateKey);
  if (!active.length) { console.error("❌ No private keys! Set PK_1 in env."); process.exit(1); }

  console.log("=".repeat(50));
  console.log("  HASH256 MINER");
  console.log(`  Threads: ${THREADS} | Wallets: ${active.length}`);
  console.log(`  Contract: ${CONTRACT_ADDRESS}`);
  console.log("=".repeat(50));

  await Promise.all(active.map((w, i) => mineForWallet(w, i)));
}

main().catch(console.error);
