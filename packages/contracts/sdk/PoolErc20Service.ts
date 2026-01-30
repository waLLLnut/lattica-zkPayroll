import type { Fr } from "@aztec/aztec.js";
import type { UltraHonkBackend } from "@aztec/bb.js";
// Dynamic import to avoid ESM/CJS conflict with hardhat
// import { poseidon2Hash as aztecPoseidon2Hash } from "@aztec/foundation/crypto";
import type { CompiledCircuit, Noir } from "@noir-lang/noir_js";
import { utils } from "@repo/utils";
import { ethers } from "ethers";
import { compact, orderBy, times } from "lodash";
import { assert, type AsyncOrSync } from "ts-essentials";
import { type PoolERC20 } from "../typechain-types";
import { EncryptionService } from "./EncryptionService";
import type { ITreesService } from "./RemoteTreesService";
import { prove, toNoirU256 } from "./utils";
import { derivePublicKey as grumpkinDerivePublicKey, hexToBigInt, bigIntToHex, type GrumpkinPoint } from "./grumpkin";

// Note: keep in sync with other languages
export const NOTE_HASH_TREE_HEIGHT = 40;
// Note: keep in sync with other languages
export const NOTE_HASH_SUBTREE_HEIGHT = 6;
// Note: keep in sync with other languages
export const MAX_NOTES_PER_ROLLUP = 64;
// Note: keep in sync with other languages
export const NULLIFIER_TREE_HEIGHT = 40;
// Note: keep in sync with other languages
export const NULLIFIER_SUBTREE_HEIGHT = 6;
// Note: keep in sync with other languages
export const MAX_NULLIFIERS_PER_ROLLUP = 64;

// Note: keep in sync with other languages
const GENERATOR_INDEX__WA_ADDRESS = 1;
// Note: keep in sync with other languages
const GENERATOR_INDEX__NOTE_NULLIFIER = 2;
// Note: keep in sync with other languages
const GENERATOR_INDEX__NOTE_HASH = 3;

// Note: keep in sync with other languages
export const MAX_TOKENS_IN_PER_EXECUTION = 4;
// Note: keep in sync with other languages
export const MAX_TOKENS_OUT_PER_EXECUTION = 4;

// Note: keep in sync with other languages
const MAX_NOTES_TO_JOIN = 2;

export const INCLUDE_UNCOMMITTED = true;

export class PoolErc20Service {
  constructor(
    readonly contract: PoolERC20,
    private encryption: EncryptionService,
    private trees: ITreesService,
    private circuits: AsyncOrSync<{
      shield: NoirAndBackend;
      unshield: NoirAndBackend;
      join: NoirAndBackend;
      transfer: NoirAndBackend;
    }>,
  ) {}

  async shield({
    account,
    token,
    amount,
    secretKey,
  }: {
    account: ethers.Signer;
    token: ethers.AddressLike;
    amount: bigint;
    secretKey: string;
  }) {
    const randomness = await getRandomness();
    const note = await Erc20Note.from({
      owner: await CompleteWaAddress.fromSecretKey(secretKey),
      amount: await TokenAmount.from({
        token: await ethers.resolveAddress(token),
        amount,
      }),
      randomness,
    });
    const noteInput = await this.toNoteInput(note);
    const shieldCircuit = (await this.circuits).shield;
    // __LatticA__: WaAddress is now {x, y} Grumpkin coordinates
    const waCoords = note.owner.getWaCoords();
    const input = {
      tree_roots: await this.trees.getTreeRoots(),
      owner: { x: waCoords.x, y: waCoords.y },
      amount: await note.amount.toNoir(),
      randomness: note.randomness,
      note_hash: noteInput.noteHash,
    };
    const { proof } = await prove("shield", shieldCircuit, input);
    const tx = await this.contract
      .connect(account)
      .shield(proof, token, amount, noteInput);
    const receipt = await tx.wait();
    console.log("shield gas used", receipt?.gasUsed);
    return { tx, note };
  }

  /**
   * Unshield tokens from privacy pool
   *
   * __LatticA__: Now computes wa_commitment for audit proof linking.
   * The wa_commitment links this on-chain proof to a separate RLWE audit proof
   * that the relayer verifies off-chain (optimistic verification).
   */
  async unshield({
    secretKey,
    fromNote,
    token,
    to,
    amount,
  }: {
    secretKey: string;
    fromNote: Erc20Note;
    token: string;
    to: string;
    amount: bigint;
  }) {
    assert(utils.isAddressEqual(token, fromNote.amount.token), "invalid token");
    const change_randomness = await getRandomness();
    const changeNote = await Erc20Note.from({
      owner: fromNote.owner,
      amount: await TokenAmount.from({
        token: fromNote.amount.token,
        amount: fromNote.amount.amount - amount,
      }),
      randomness: change_randomness,
    });
    assert(changeNote.amount.amount >= 0n, "invalid change note");

    const nullifier = await fromNote.computeNullifier(secretKey);

    // __LatticA__: Compute wa_commitment for audit proof linking
    const waAddress = await CompleteWaAddress.fromSecretKey(secretKey);
    const waCommitment = await computeWaCommitment(waAddress);

    const unshieldCircuit = (await this.circuits).unshield;
    const input = {
      tree_roots: await this.trees.getTreeRoots(),
      from_secret_key: secretKey,
      from_note_inputs: await this.toNoteConsumptionInputs(secretKey, fromNote),
      to: { inner: to },
      amount: await (
        await TokenAmount.from({
          amount,
          token,
        })
      ).toNoir(),
      change_randomness,
      // return
      nullifier: nullifier.toString(),
      change_note_hash: await changeNote.hash(),
    };
    const { proof } = await prove("unshield", unshieldCircuit, input);

    // __LatticA__: Include wa_commitment in contract call
    const tx = await this.contract.unshield(
      proof,
      token,
      to,
      amount,
      nullifier.toString(),
      await this.toNoteInput(changeNote),
      waCommitment.toString(), // For audit proof linking
    );
    const receipt = await tx.wait();
    console.log("unshield gas used", receipt?.gasUsed);

    // __LatticA__: Return wa_commitment and nullifier for audit proof generation
    return {
      tx,
      note: fromNote,
      changeNote,
      nullifier: nullifier.toString(),
      waCommitment: waCommitment.toString(),
      noteHash: await fromNote.hash(),
    };
  }

  async join({
    secretKey,
    notes,
    to,
  }: {
    secretKey: string;
    notes: Erc20Note[];
    to?: CompleteWaAddress;
  }) {
    assert(notes.length === MAX_NOTES_TO_JOIN, "invalid notes length");

    const join_randomness = await getRandomness();

    // __LatticA__: to is WaAddress {x, y} Grumpkin coordinates
    const toAddress = to ?? await CompleteWaAddress.fromSecretKey(secretKey);
    const toWaCoords = toAddress.getWaCoords();

    const joinCircuit = (await this.circuits).join;
    const input = {
      tree_roots: await this.trees.getTreeRoots(),
      from_secret_key: secretKey,
      join_randomness,
      to: { x: toWaCoords.x, y: toWaCoords.y },
      notes: await Promise.all(
        notes.map((note) => this.toNoteConsumptionInputs(secretKey, note)),
      ),
    };
    const { proof } = await prove("join", joinCircuit, input);

    const joinNote = await Erc20Note.from({
      owner: await CompleteWaAddress.fromSecretKey(secretKey),
      amount: await TokenAmount.from({
        token: notes[0]!.amount.token,
        amount: notes.reduce((acc, note) => acc + note.amount.amount, 0n),
      }),
      randomness: join_randomness,
    });

    const tx = await this.contract.join(
      proof,
      (await Promise.all(
        notes.map(async (note) =>
          (await note.computeNullifier(secretKey)).toString(),
        ),
      )) as any,
      await this.toNoteInput(joinNote),
    );
    const receipt = await tx.wait(0);
    console.log("join gas used", receipt?.gasUsed);
  }

  async transfer({
    secretKey,
    fromNote,
    to,
    amount,
  }: {
    secretKey: string;
    fromNote: Erc20Note;
    to: CompleteWaAddress;
    amount: TokenAmount;
  }) {
    const nullifier = await fromNote.computeNullifier(secretKey);

    const to_randomness = await getRandomness();
    const change_randomness = await getRandomness();
    // __LatticA__: to is WaAddress {x, y} Grumpkin coordinates
    const toWaCoords = to.getWaCoords();
    const input = {
      tree_roots: await this.trees.getTreeRoots(),
      from_note_inputs: await this.toNoteConsumptionInputs(secretKey, fromNote),
      from_secret_key: secretKey,
      to: { x: toWaCoords.x, y: toWaCoords.y },
      amount: await amount.toNoir(),
      to_randomness,
      change_randomness,
    };
    const changeNote = await Erc20Note.from({
      owner: fromNote.owner,
      amount: fromNote.amount.sub(amount),
      randomness: change_randomness,
    });
    assert(changeNote.amount.amount >= 0n, "invalid change note");
    const toNote = await Erc20Note.from({
      owner: to,
      amount,
      randomness: to_randomness,
    });
    // console.log("input\n", JSON.stringify(input));
    const transferCircuit = (await this.circuits).transfer;
    const { proof } = await prove("transfer", transferCircuit, input);

    const tx = await this.contract.transfer(
      proof,
      nullifier.toString(),
      await this.toNoteInput(changeNote),
      await this.toNoteInput(toNote),
    );

    const receipt = await tx.wait();
    console.log("transfer gas used", receipt?.gasUsed);
    // console.log("nullifier", nullifier.toString());
    return {
      tx,
      nullifier: nullifier.toString(),
      changeNote,
      toNote,
    };
  }

  async balanceOfNew(token: ethers.AddressLike, secretKey: string) {
    const notes = await this.getBalanceNotesOf(token, secretKey);
    const balance = notes.reduce((acc, note) => acc + note.amount.amount, 0n);
    return [balance, notes] as const;
  }

  /** @deprecated use .balanceOfNew */
  async balanceOf(token: ethers.AddressLike, secretKey: string) {
    const notes = await this.getBalanceNotesOf(token, secretKey);
    return notes.reduce((acc, note) => acc + note.amount.amount, 0n);
  }

  async getBalanceNotesOf(token: ethers.AddressLike, secretKey: string) {
    token = await ethers.resolveAddress(token);
    const notes = await this.getEmittedNotes(secretKey);
    return notes.filter(
      (note) => note.amount.token.toLowerCase() === token.toLowerCase(),
    );
  }

  async toNoteConsumptionInputs(secretKey: string, note: Erc20Note) {
    const nullifier = await note.computeNullifier(secretKey);
    const noteConsumptionInputs = await this.trees.getNoteConsumptionInputs({
      noteHash: await note.hash(),
      nullifier: nullifier.toString(),
    });
    return {
      ...noteConsumptionInputs,
      note: await note.toNoir(),
    };
  }

  /**
   * @deprecated use {@link Erc20Note.toSolidityNoteInput} instead
   */
  async toNoteInput(note: Erc20Note) {
    return await note.toSolidityNoteInput();
  }

  private async getEmittedNotes(secretKey: string) {
    const { address } = await CompleteWaAddress.fromSecretKey(secretKey);
    const encrypted = sortEvents(
      await paginatedQueryFilter(this.contract, this.contract.filters.EncryptedNotes()),
    )
      .map((e) => e.args.encryptedNotes.map((note) => note.encryptedNote))
      .flat();
    const publicKey = await this.encryption.derivePublicKey(secretKey);
    const decrypted = encrypted.map(async (encryptedNote) => {
      const note = await Erc20Note.tryDecrypt(
        secretKey,
        publicKey,
        encryptedNote,
      );
      if (!note) {
        return undefined;
      }

      const noteValid: boolean = await this.trees.noteExistsAndNotNullified({
        noteHash: await note.hash(),
        nullifier: (await note.computeNullifier(secretKey)).toString(),
      });
      if (!noteValid) {
        return undefined;
      }

      assert(
        note.owner.address.toLowerCase() === address.toLowerCase(),
        "invalid note received",
      );

      return note;
    });
    return compact(await Promise.all(decrypted));
  }
}

export class Erc20Note {
  constructor(
    readonly owner: CompleteWaAddress,
    readonly amount: TokenAmount,
    readonly randomness: string,
  ) {}

  static async from(params: {
    owner: CompleteWaAddress;
    amount: TokenAmount;
    randomness: string;
  }) {
    return new Erc20Note(params.owner, params.amount, params.randomness);
  }

  async toNoir() {
    // __LatticA__: owner is now WaAddress {x, y} Grumpkin coordinates
    const waCoords = this.owner.getWaCoords();
    return {
      owner: { x: waCoords.x, y: waCoords.y },
      amount: await this.amount.toNoir(),
      randomness: this.randomness,
    };
  }

  async toSolidityNoteInput() {
    return {
      noteHash: await this.hash(),
      encryptedNote: await this.encrypt(),
    };
  }

  async serialize(): Promise<bigint[]> {
    const amount = await this.amount.toNoir();
    // Must match Noir's Erc20Note.serialize(): [owner.x, owner.y, token, amount, randomness]
    const waCoords = this.owner.getWaCoords();
    return [
      BigInt(waCoords.x),
      BigInt(waCoords.y),
      BigInt(this.amount.token),
      // ...amount.amount.limbs.map((x) => BigInt(x)),
      BigInt(amount.amount.value),
      BigInt(this.randomness),
    ];
  }

  static async deserialize(
    fields: bigint[],
    publicKey: string,
  ): Promise<Erc20Note> {
    // fields: [owner.x, owner.y, token, amount, randomness]
    const fieldsStr = fields.map((x) => ethers.toBeArray(x));
    const waX = bigIntToHex(fields[0]!);
    const waY = bigIntToHex(fields[1]!);
    const waCoords: WaAddressCoords = { x: waX, y: waY };
    const waCommitment = await poseidon2Hash([
      GENERATOR_INDEX__WA_ADDRESS,
      fields[0]!,
      fields[1]!,
    ]);
    return await Erc20Note.from({
      owner: new CompleteWaAddress(
        waCommitment.toString(),
        publicKey,
        waCoords,
      ),
      amount: await TokenAmount.from({
        token: ethers.zeroPadValue(fieldsStr[2]!, 20),
        // amount: fromNoirU256({ limbs: fields.slice(3, 3 + U256_LIMBS) }),
        amount: ethers.toBigInt(fieldsStr[3]!),
      }),
      randomness: ethers.zeroPadValue(fieldsStr[4]!, 32),
    });
  }

  async hash(): Promise<string> {
    return (
      await poseidon2Hash([
        GENERATOR_INDEX__NOTE_HASH,
        ...(await this.serialize()),
      ])
    ).toString();
  }

  async computeNullifier(secretKey: string) {
    assert(
      (await CompleteWaAddress.fromSecretKey(secretKey)).equal(this.owner),
      "invalid nullifier secret key",
    );
    return await poseidon2Hash([
      GENERATOR_INDEX__NOTE_NULLIFIER,
      await this.hash(),
      secretKey,
    ]);
  }

  static async empty() {
    return await Erc20Note.from({
      owner: new CompleteWaAddress(ethers.ZeroHash, ethers.ZeroHash, { x: ethers.ZeroHash, y: ethers.ZeroHash }),
      amount: await TokenAmount.empty(),
      randomness: ethers.ZeroHash,
    });
  }

  async encrypt() {
    const serialized = await this.serialize();
    const hex = ethers.AbiCoder.defaultAbiCoder().encode(
      times(serialized.length, () => "uint256"),
      serialized,
    );
    return await EncryptionService.getSingleton().encrypt(
      this.owner.publicKey,
      hex,
    );
  }

  static async tryDecrypt(
    secretKey: string,
    publicKey: string,
    encryptedNote: string,
  ) {
    const encryption = EncryptionService.getSingleton();
    let hex: string;
    try {
      hex = await encryption.decrypt(secretKey, encryptedNote);
    } catch (e) {
      return undefined;
    }
    const fields = ethers.AbiCoder.defaultAbiCoder().decode(
      times(await Erc20Note.serializedLength(), () => "uint256"),
      hex,
    );
    return await Erc20Note.deserialize(fields, publicKey);
  }

  static async serializedLength() {
    return (await (await Erc20Note.empty()).serialize()).length;
  }
}

// TODO: replace with uniswap's CurrencyAmount
export class TokenAmount {
  constructor(
    readonly token: string,
    readonly amount: bigint,
  ) {}

  static async from(params: { token: string; amount: bigint }) {
    return new TokenAmount(params.token, params.amount);
  }

  static async empty(): Promise<TokenAmount> {
    return await TokenAmount.from({ token: ethers.ZeroHash, amount: 0n });
  }

  async toNoir() {
    return {
      token: { inner: this.token },
      amount: toNoirU256(this.amount),
    };
  }

  sub(other: TokenAmount): TokenAmount {
    const result = this.amount - other.amount;
    assert(result >= 0n, "TokenAmount.sub: underflow");
    return new TokenAmount(this.token, result);
  }
}

/**
 * WaAddress represents a user's identity in the shielded pool.
 *
 * In Noir, WaAddress is a Baby JubJub/Grumpkin public key (x, y coordinates).
 * For SDK compatibility, we store it as a single Field (the hash of x and y).
 *
 * @deprecated Use `address` field which is now computed from Grumpkin pubkey
 */
export type WaAddress = string;

/**
 * Grumpkin public key coordinates (matches Noir's WaAddress struct)
 */
export interface WaAddressCoords {
  x: string;  // hex string
  y: string;  // hex string
}

export class CompleteWaAddress {
  /**
   * @param address - wa_address hash (poseidon2_hash_with_separator([x, y], 1))
   * @param publicKey - encryption public key (for note encryption)
   * @param waCoords - Grumpkin public key (x, y) coordinates (optional, for audit)
   */
  constructor(
    readonly address: WaAddress,
    readonly publicKey: string,
    readonly waCoords?: WaAddressCoords,
  ) {}

  toString() {
    return ethers.concat([this.address, this.publicKey]);
  }

  static fromString(str: string) {
    const bytes = ethers.getBytes(str);
    utils.assert(bytes.length === 64, "invalid complete address");
    const address = ethers.dataSlice(bytes, 0, 32);
    const publicKey = ethers.dataSlice(bytes, 32, 64);
    return new CompleteWaAddress(address, publicKey);
  }

  /**
   * Derive CompleteWaAddress from secret key
   *
   * This now correctly uses Grumpkin curve scalar multiplication
   * to match Noir's WaAddress::from_secret_key() implementation.
   *
   * Process:
   * 1. Compute Grumpkin public key: (x, y) = secretKey * G
   * 2. Compute wa_commitment: hash([1, x, y])
   * 3. Derive encryption public key (for note encryption)
   *
   * The `address` field is now the wa_commitment (hash of x, y).
   */
  static async fromSecretKey(secretKey: string) {
    // 1. Derive Grumpkin public key: pubKey = secretKey * G
    const secretKeyBigInt = hexToBigInt(secretKey);
    const grumpkinPubKey: GrumpkinPoint = grumpkinDerivePublicKey(secretKeyBigInt);

    // Store coordinates for audit purposes
    const waCoords: WaAddressCoords = {
      x: bigIntToHex(grumpkinPubKey.x),
      y: bigIntToHex(grumpkinPubKey.y),
    };

    // 2. Compute wa_commitment: hash([GENERATOR_INDEX, x, y])
    // This matches Noir's WaAddress::to_hash()
    const waCommitment = await poseidon2Hash([
      GENERATOR_INDEX__WA_ADDRESS,
      grumpkinPubKey.x,
      grumpkinPubKey.y,
    ]);

    // The address is the wa_commitment hash
    const address = waCommitment.toString();

    // 3. Derive encryption public key (for note encryption)
    const publicKey =
      await EncryptionService.getSingleton().derivePublicKey(secretKey);

    return new CompleteWaAddress(address, publicKey, waCoords);
  }

  equal(other: CompleteWaAddress) {
    return (
      utils.isAddressEqual(this.address, other.address) &&
      this.publicKey === other.publicKey
    );
  }

  /**
   * Get Grumpkin public key coordinates
   * Throws if waCoords was not stored (created via fromString)
   */
  getWaCoords(): WaAddressCoords {
    if (!this.waCoords) {
      throw new Error(
        "WaAddress coordinates not available. Use fromSecretKey() to create CompleteWaAddress with coordinates."
      );
    }
    return this.waCoords;
  }
}

export type NoirAndBackend = {
  circuit: CompiledCircuit;
  noir: Noir;
  backend: UltraHonkBackend;
};

/**
 * Poseidon2 hash using Aztec's implementation
 *
 * IMPORTANT: This uses @aztec/foundation/crypto which matches Noir's poseidon2.
 * Do NOT use poseidon-lite as it uses different constants and produces different results.
 */
export async function poseidon2Hash(inputs: (bigint | string | number)[]) {
  const { Fr } = await import("@aztec/aztec.js");
  const frInputs = inputs.map((x) => new Fr(BigInt(x)));
  const { poseidon2Hash: aztecPoseidon2Hash } = await import("@aztec/foundation/crypto");
  return await aztecPoseidon2Hash(frInputs);
}

async function paginatedQueryFilter<T>(contract: any, filter: any): Promise<T[]> {
  const fromBlock = process.env.POOL_DEPLOY_BLOCK ? parseInt(process.env.POOL_DEPLOY_BLOCK) : undefined;
  if (!fromBlock) {
    return contract.queryFilter(filter) as Promise<T[]>;
  }
  const provider = contract.runner?.provider;
  if (!provider) return contract.queryFilter(filter) as Promise<T[]>;
  const latestBlock = await provider.getBlockNumber();
  const results: T[] = [];
  const CHUNK = 1024;
  for (let from = fromBlock; from <= latestBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, latestBlock);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const events = await contract.queryFilter(filter, from, to);
        results.push(...(events as T[]));
        break;
      } catch (e: any) {
        if (attempt === 2) throw e;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  return results;
}

function sortEvents<
  T extends {
    blockNumber: number;
    transactionIndex: number;
    index: number;
  },
>(events: T[]) {
  return orderBy(
    events,
    (e) => `${e.blockNumber}-${e.transactionIndex}-${e.index}`,
  );
}

export async function getRandomness() {
  const { Fr } = await import("@aztec/aztec.js");
  return Fr.random().toString();
}

/**
 * __LatticA__: Compute wa_commitment (hash of WaAddress)
 *
 * This matches the Noir circuit's WaAddress::to_hash() function:
 * wa_commitment = poseidon2_hash_with_separator([wa_address.x, wa_address.y], GENERATOR_INDEX__WA_ADDRESS)
 *
 * The separator is prepended to the inputs before hashing.
 */
export async function computeWaCommitmentFromXY(
  waAddressX: string | bigint,
  waAddressY: string | bigint
): Promise<Fr> {
  // Matches Noir: poseidon2_hash_with_separator([x, y], GENERATOR_INDEX__WA_ADDRESS)
  // The separator is prepended: hash([separator, x, y])
  return await poseidon2Hash([GENERATOR_INDEX__WA_ADDRESS, waAddressX, waAddressY]);
}

/**
 * __LatticA__: Derive wa_address (Grumpkin public key) from secret key
 *
 * Correctly uses Grumpkin curve scalar multiplication to match
 * Noir's WaAddress::from_secret_key() implementation.
 *
 * Returns:
 * - x, y: Grumpkin public key coordinates
 * - commitment: wa_commitment hash for on-chain storage
 */
export async function deriveWaAddressFromSecretKey(
  secretKey: string,
): Promise<{ x: bigint; y: bigint; commitment: Fr }> {
  // 1. Derive Grumpkin public key: pubKey = secretKey * G
  const secretKeyBigInt = hexToBigInt(secretKey);
  const grumpkinPubKey = grumpkinDerivePublicKey(secretKeyBigInt);

  // 2. Compute wa_commitment: hash([GENERATOR_INDEX, x, y])
  const commitment = await computeWaCommitmentFromXY(
    grumpkinPubKey.x,
    grumpkinPubKey.y
  );

  return {
    x: grumpkinPubKey.x,
    y: grumpkinPubKey.y,
    commitment,
  };
}

/**
 * __LatticA__: Compute wa_commitment from CompleteWaAddress
 *
 * If waCoords are available (from fromSecretKey), uses those.
 * Otherwise falls back to deriving from secret key (requires secretKey parameter).
 */
export async function computeWaCommitment(waAddress: CompleteWaAddress): Promise<Fr>;
export async function computeWaCommitment(secretKey: string): Promise<Fr>;
export async function computeWaCommitment(input: CompleteWaAddress | string): Promise<Fr> {
  if (typeof input === "string") {
    // Input is secretKey, derive full wa_address
    const { commitment } = await deriveWaAddressFromSecretKey(input);
    return commitment;
  } else {
    // Input is CompleteWaAddress
    const waCoords = input.waCoords;
    if (waCoords) {
      return await computeWaCommitmentFromXY(waCoords.x, waCoords.y);
    }
    // Fallback: address is already the commitment
    const { Fr } = await import("@aztec/aztec.js");
    return new Fr(BigInt(input.address));
  }
}
