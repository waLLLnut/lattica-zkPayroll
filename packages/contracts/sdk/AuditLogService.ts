import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import type { PoolERC20 } from "../typechain-types";
import {
  RlweKeygenService,
  RLWE_N as KEYGEN_RLWE_N,
  RLWE_Q,
  RLWE_MESSAGE_SLOTS as KEYGEN_MESSAGE_SLOTS,
} from "./RlweKeygenService";

// RLWE parameters (must match Solidity and Noir)
export const RLWE_MESSAGE_SLOTS = 32;
export const RLWE_N = 1024;
export const RLWE_CT_SIZE = RLWE_MESSAGE_SLOTS + RLWE_N; // 1056

/**
 * __LatticA__: Audit entry from UnshieldAuditLog event
 * Uses optimistic two-proof architecture:
 * - wa_commitment stored on-chain (from main proof)
 * - Full RLWE ciphertext stored off-chain (IPFS)
 */
export interface OptimisticAuditEntry {
  nullifier: string;
  waCommitment: string;
  blockNumber: number;
  transactionHash: string;
}

/**
 * Service for querying RLWE audit logs
 *
 * __LatticA__: Updated for optimistic two-proof architecture.
 * - On-chain: Only wa_commitment from main unshield proof
 * - Off-chain: Full RLWE ciphertext via RlweAuditChallenge + IPFS
 */
export class AuditLogService {
  private fromBlock?: number;

  constructor(readonly poolContract: PoolERC20, fromBlock?: number) {
    this.fromBlock = fromBlock ?? (process.env.POOL_DEPLOY_BLOCK ? parseInt(process.env.POOL_DEPLOY_BLOCK) : undefined);
  }

  private async paginatedQueryFilter(filter: any) {
    if (!this.fromBlock) {
      return this.poolContract.queryFilter(filter);
    }
    const provider = this.poolContract.runner?.provider;
    if (!provider) return this.poolContract.queryFilter(filter);
    const latestBlock = await provider.getBlockNumber();
    const results: any[] = [];
    const CHUNK = 1024;
    for (let from = this.fromBlock; from <= latestBlock; from += CHUNK) {
      const to = Math.min(from + CHUNK - 1, latestBlock);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const events = await this.poolContract.queryFilter(filter, from, to);
          results.push(...events);
          break;
        } catch (e: any) {
          if (attempt === 2) throw e;
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    return results;
  }

  /**
   * Query audit log by nullifier from UnshieldAuditLog event
   * @param nullifier The transaction nullifier
   */
  async queryAuditLog(nullifier: string): Promise<OptimisticAuditEntry | null> {
    const filter = this.poolContract.filters.UnshieldAuditLog(nullifier);
    const events = await this.paginatedQueryFilter(filter);

    if (events.length === 0) {
      return null;
    }

    const event = events[0]!;
    return {
      nullifier: (event as any).args.nullifier,
      waCommitment: (event as any).args.waCommitment,
      blockNumber: (event as any).blockNumber,
      transactionHash: (event as any).transactionHash,
    };
  }

  /**
   * Get all audit logs from UnshieldAuditLog events
   * Useful for batch querying or UI display
   */
  async getAllAuditLogs(): Promise<OptimisticAuditEntry[]> {
    const filter = this.poolContract.filters.UnshieldAuditLog();
    const events = await this.paginatedQueryFilter(filter);

    return events.map((event: any) => ({
      nullifier: event.args.nullifier,
      waCommitment: event.args.waCommitment,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
    }));
  }

  /**
   * Query audit logs by wa_commitment
   * Useful for finding all transactions from a specific user identity
   */
  async queryByWaCommitment(
    waCommitment: string,
  ): Promise<OptimisticAuditEntry[]> {
    const allLogs = await this.getAllAuditLogs();
    return allLogs.filter(
      (log) => log.waCommitment.toLowerCase() === waCommitment.toLowerCase(),
    );
  }

  /**
   * Query audit logs within a block range
   */
  async queryByBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<OptimisticAuditEntry[]> {
    const filter = this.poolContract.filters.UnshieldAuditLog();
    const events = await this.poolContract.queryFilter(
      filter,
      fromBlock,
      toBlock,
    );

    return events.map((event) => ({
      nullifier: event.args.nullifier,
      waCommitment: event.args.waCommitment,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
    }));
  }

  /**
   * Check if an audit log exists for a nullifier
   */
  async auditLogExists(nullifier: string): Promise<boolean> {
    const entry = await this.queryAuditLog(nullifier);
    return entry !== null;
  }

  /**
   * Parse RLWE ciphertext bytes into c0 and c1 components
   * Used when retrieving full ciphertext from IPFS
   */
  parseRlweCiphertext(ciphertext: string): {
    c0: bigint[];
    c1: bigint[];
  } {
    const bytes = ethers.getBytes(ciphertext);
    const fieldSize = 32; // Each field element is 32 bytes

    const c0: bigint[] = [];
    const c1: bigint[] = [];

    // Parse c0 (first RLWE_MESSAGE_SLOTS fields)
    for (let i = 0; i < RLWE_MESSAGE_SLOTS; i++) {
      const start = i * fieldSize;
      const fieldBytes = bytes.slice(start, start + fieldSize);
      c0.push(ethers.toBigInt(fieldBytes));
    }

    // Parse c1 (next RLWE_N fields)
    for (let i = 0; i < RLWE_N; i++) {
      const start = (RLWE_MESSAGE_SLOTS + i) * fieldSize;
      const fieldBytes = bytes.slice(start, start + fieldSize);
      c1.push(ethers.toBigInt(fieldBytes));
    }

    return { c0, c1 };
  }

  /**
   * Encode ciphertext components to bytes for IPFS storage
   */
  encodeRlweCiphertext(c0: bigint[], c1: bigint[]): string {
    const parts: string[] = [];

    // Encode c0
    for (let i = 0; i < RLWE_MESSAGE_SLOTS; i++) {
      parts.push(ethers.zeroPadValue(ethers.toBeHex(c0[i] ?? 0n), 32));
    }

    // Encode c1
    for (let i = 0; i < RLWE_N; i++) {
      parts.push(ethers.zeroPadValue(ethers.toBeHex(c1[i] ?? 0n), 32));
    }

    return ethers.concat(parts);
  }

  /**
   * Open/decrypt an audit log entry to reveal the sender's identity
   *
   * @param nullifier The nullifier to look up
   * @param secretKey The RLWE secret key (from company's secure storage)
   * @param ciphertext The full ciphertext (from IPFS or other storage)
   * @returns Decrypted wa_address (x, y) if found
   */
  async openAuditLog(
    nullifier: string,
    secretKey: bigint[],
    ciphertext: { c0: bigint[]; c1: bigint[] },
  ): Promise<{ x: bigint; y: bigint; found: boolean }> {
    // First check if the audit log exists
    const entry = await this.queryAuditLog(nullifier);
    if (!entry) {
      return { x: 0n, y: 0n, found: false };
    }

    // Decrypt the ciphertext
    const waAddress = RlweKeygenService.decryptWaAddress(
      ciphertext.c0,
      ciphertext.c1,
      secretKey,
    );

    return { ...waAddress, found: true };
  }

  /**
   * Open audit log from raw ciphertext bytes
   */
  async openAuditLogFromBytes(
    nullifier: string,
    secretKey: bigint[],
    ciphertextBytes: string,
  ): Promise<{ x: bigint; y: bigint; found: boolean }> {
    const parsed = this.parseRlweCiphertext(ciphertextBytes);
    return this.openAuditLog(nullifier, secretKey, parsed);
  }
}

/**
 * RLWE Audit System Manager
 *
 * Handles initialization and management of the RLWE audit system.
 * Companies use this to:
 * 1. Generate RLWE keys during system setup
 * 2. Store secret key securely (or share with trusted parties)
 * 3. Export public key to circuit for compilation
 */
export class RlweAuditSystemManager {
  private secretKey?: bigint[];
  private seed?: string;

  constructor(
    private noirCircuitPath: string,
    private secretKeyStoragePath?: string,
  ) {}

  /**
   * Initialize the RLWE audit system
   *
   * @param options Configuration options
   * @param options.seed Optional seed for deterministic key generation
   * @param options.shareSecretKey If true, returns secret key for sharing; if false, stores internally
   * @returns Initialization result with public key path and optional secret key
   */
  async initialize(options: {
    seed?: string;
    shareSecretKey?: boolean;
  } = {}): Promise<{
    success: boolean;
    pkNoirPath: string;
    seed: string;
    secretKeyJson?: string; // Only returned if shareSecretKey is true
    message: string;
  }> {
    const seed = options.seed ?? RlweKeygenService.generateRandomSeed();
    this.seed = seed;

    console.log("=".repeat(60));
    console.log("RLWE Audit System Initialization");
    console.log("=".repeat(60));
    console.log(`Seed: ${seed}`);
    console.log(`Parameters: N=${RLWE_N}, Q=${RLWE_Q}, slots=${RLWE_MESSAGE_SLOTS}`);

    // Generate key pair
    const keyPair = RlweKeygenService.generateKeyPair(seed);
    this.secretKey = keyPair.secretKey;

    // Export public key to Noir
    const pkNoirPath = path.join(this.noirCircuitPath, "pk.nr");
    console.log(`\nExporting public key to: ${pkNoirPath}`);
    RlweKeygenService.exportToNoir(keyPair, pkNoirPath);

    // Get file size
    const stats = fs.statSync(pkNoirPath);
    console.log(`Generated pk.nr: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // Store secret key if path provided
    const secretKeyJson = RlweKeygenService.exportSecretKey(keyPair);
    if (this.secretKeyStoragePath) {
      fs.writeFileSync(this.secretKeyStoragePath, secretKeyJson);
      console.log(`\nSecret key stored at: ${this.secretKeyStoragePath}`);
    }

    const result: {
      success: boolean;
      pkNoirPath: string;
      seed: string;
      secretKeyJson?: string;
      message: string;
    } = {
      success: true,
      pkNoirPath,
      seed,
      message: options.shareSecretKey
        ? "Secret key returned for sharing. Store securely!"
        : "Secret key stored internally. Use loadSecretKey() if needed.",
    };

    if (options.shareSecretKey) {
      result.secretKeyJson = secretKeyJson;
    }

    console.log("\n" + "=".repeat(60));
    console.log("Initialization complete!");
    console.log(`Next step: Compile the rlwe_audit circuit with 'nargo compile'`);
    console.log("=".repeat(60));

    return result;
  }

  /**
   * Load secret key from storage
   */
  loadSecretKey(jsonOrPath?: string): bigint[] {
    let json: string;

    if (jsonOrPath) {
      // Could be JSON string or file path
      if (jsonOrPath.startsWith("{")) {
        json = jsonOrPath;
      } else {
        json = fs.readFileSync(jsonOrPath, "utf8");
      }
    } else if (this.secretKeyStoragePath) {
      json = fs.readFileSync(this.secretKeyStoragePath, "utf8");
    } else if (this.secretKey) {
      return this.secretKey;
    } else {
      throw new Error("No secret key available. Initialize first or provide path.");
    }

    this.secretKey = RlweKeygenService.importSecretKey(json);
    return this.secretKey;
  }

  /**
   * Decrypt a ciphertext using the loaded secret key
   */
  decrypt(c0: bigint[], c1: bigint[]): { x: bigint; y: bigint } {
    if (!this.secretKey) {
      throw new Error("Secret key not loaded. Call loadSecretKey() first.");
    }
    return RlweKeygenService.decryptWaAddress(c0, c1, this.secretKey);
  }

  /**
   * Verify that the pk.nr file matches the current seed
   */
  verifyPkNoir(): boolean {
    if (!this.seed) {
      throw new Error("No seed available. Initialize first.");
    }
    const pkNoirPath = path.join(this.noirCircuitPath, "pk.nr");
    return this.verifyPkNoirWithSeed(pkNoirPath, this.seed);
  }

  /**
   * Verify pk.nr with a specific seed
   */
  verifyPkNoirWithSeed(pkNoirPath: string, seed: string): boolean {
    const content = fs.readFileSync(pkNoirPath, "utf8");

    if (!content.includes(seed)) {
      console.error("Seed not found in pk.nr header");
      return false;
    }

    // Regenerate and compare first row
    const keyPair = RlweKeygenService.generateKeyPair(seed);
    const rows = RlweKeygenService.computePublicKeyRows(keyPair);
    const firstRowStr = rows.pkARows[0]!.join(", ");

    if (!content.includes(firstRowStr.substring(0, 100))) {
      console.error("First PK_A row doesn't match");
      return false;
    }

    return true;
  }

  /**
   * Get the current seed (for backup/sharing)
   */
  getSeed(): string {
    if (!this.seed) {
      throw new Error("No seed available. Initialize first.");
    }
    return this.seed;
  }
}
