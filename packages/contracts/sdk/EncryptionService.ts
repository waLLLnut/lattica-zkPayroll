import { utils } from "@repo/utils";
import { ethers } from "ethers";
import { assert } from "ts-essentials";

// TODO(security): Constrain encryption and nuke this service.
export class EncryptionService {
  #suite: any;

  private constructor() {}

  static getSingleton = utils.lazyValue(() => new EncryptionService());

  async #ensureSuite() {
    if (!this.#suite) {
      const { Aes128Gcm, CipherSuite, HkdfSha256 } = await import("@hpke/core");
      const { DhkemX25519HkdfSha256 } = await import("@hpke/dhkem-x25519");
      this.#suite = new CipherSuite({
        kem: new DhkemX25519HkdfSha256(),
        kdf: new HkdfSha256(),
        aead: new Aes128Gcm(),
      });
    }
    return this.#suite;
  }

  async encrypt(publicKey: ethers.BytesLike, messageBytes: ethers.BytesLike) {
    const suite = await this.#ensureSuite();
    const importedPublicKey = await this.#importPublicKey(publicKey);
    const sender = await suite.createSenderContext({
      recipientPublicKey: importedPublicKey,
    });
    const enc = new Uint8Array(sender.enc);
    assert(enc.length === ECC_LEN, "invalid encryption context length");

    const encrypted = new Uint8Array(
      await sender.seal(ethers.getBytes(messageBytes)),
    );
    return ethers.concat([enc, encrypted]);
  }

  async decrypt(privateKey: ethers.BytesLike, ciphertext: ethers.BytesLike) {
    const suite = await this.#ensureSuite();
    const importedPrivateKey = await this.#importPrivateKey(privateKey);
    ciphertext = ethers.getBytes(ciphertext);
    const recipient = await suite.createRecipientContext({
      recipientKey: importedPrivateKey,
      enc: ciphertext.subarray(0, ECC_LEN),
    });
    const plaintext = await recipient.open(ciphertext.subarray(ECC_LEN));
    return ethers.hexlify(new Uint8Array(plaintext));
  }

  async derivePublicKey(privateKey: ethers.BytesLike) {
    const suite = await this.#ensureSuite();
    const { X25519 } = await import("@hpke/dhkem-x25519");
    const importedPrivateKey = await this.#importPrivateKey(privateKey);
    const publicKey = await new X25519(suite.kdf).derivePublicKey(
      importedPrivateKey,
    );
    return ethers.hexlify(
      new Uint8Array(await suite.kem.serializePublicKey(publicKey)),
    );
  }

  async #importPrivateKey(privateKey: ethers.BytesLike) {
    const suite = await this.#ensureSuite();
    return await suite.kem.importKey(
      "raw",
      ethers.getBytes(privateKey),
      false, // isPublic
    );
  }

  async #importPublicKey(publicKey: ethers.BytesLike) {
    const suite = await this.#ensureSuite();
    return await suite.kem.importKey(
      "raw",
      ethers.getBytes(publicKey),
      true, // isPublic
    );
  }
}

const ECC_LEN = 32;
