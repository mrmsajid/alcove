// Chrome extension packages (.crx): split off the zip, and check the package is signed by the key its ID comes from.
//
// An extension's ID is the first 16 bytes of the SHA-256 of its public key, written with the letters a-p. A CRX carries
// that key and a signature over the zip, so a package whose key doesn't produce the requested ID, or whose signature
// doesn't verify, is not the extension that was asked for. This is the same check Chrome makes. (It cannot say the
// publisher is trustworthy: that is what the permission review before installing is for.)
const crypto = require("crypto");

const MAGIC = "Cr24";
const SIGNED_DATA_CONTEXT = Buffer.from("CRX3 SignedData\0", "latin1");

// The a-p form of 16 bytes: each hex digit 0-f becomes a-p.
const idFromBytes = bytes => [...bytes].map(b => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
const extensionIdFromKey = der => idFromBytes(crypto.createHash("sha256").update(der).digest().subarray(0, 16));

// Minimal protobuf reader: the fields of one message as [fieldNumber, wireType, value] (value: Buffer for length-delimited).
function readFields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let n = 0, shift = 0;
    for (;;) {
      if (i >= buf.length || shift > 35) throw new Error("bad CRX header");
      const b = buf[i++];
      n += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return n;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const tag = varint(), field = Math.floor(tag / 8), wire = tag & 7;
    if (wire === 2) {
      const len = varint();
      if (i + len > buf.length) throw new Error("bad CRX header");
      out.push([field, wire, buf.subarray(i, i + len)]);
      i += len;
    } else if (wire === 0) out.push([field, wire, varint()]);
    else throw new Error("bad CRX header"); // the header uses only these two kinds
  }
  return out;
}

// The zip inside a package (a plain zip is returned as it is).
function crxToZip(buf) {
  if (buf.subarray(0, 4).toString("latin1") !== MAGIC) return buf;
  const version = buf.readUInt32LE(4);
  if (version === 3) return buf.subarray(12 + buf.readUInt32LE(8));
  if (version === 2) return buf.subarray(16 + buf.readUInt32LE(8) + buf.readUInt32LE(12));
  throw new Error("unsupported CRX version");
}

// Throws unless `buf` is a CRX signed by the key behind `expectedId`; returns the zip.
function verifyCrx(buf, expectedId) {
  if (buf.length < 16 || buf.subarray(0, 4).toString("latin1") !== MAGIC) throw new Error("not an extension package");
  const version = buf.readUInt32LE(4);
  const fail = why => { throw new Error(`the download isn't the extension that was asked for (${why})`); };
  const verify = (algo, data, der, sig) => {
    try { return crypto.verify(algo, data, crypto.createPublicKey({ key: der, format: "der", type: "spki" }), sig); } catch { return false; }
  };

  if (version === 2) {
    const keyLen = buf.readUInt32LE(8), sigLen = buf.readUInt32LE(12);
    if (16 + keyLen + sigLen > buf.length) fail("truncated");
    const key = buf.subarray(16, 16 + keyLen), sig = buf.subarray(16 + keyLen, 16 + keyLen + sigLen), zip = buf.subarray(16 + keyLen + sigLen);
    if (extensionIdFromKey(key) !== expectedId) fail("its key belongs to a different extension");
    if (!verify("sha1", zip, key, sig)) fail("bad signature");
    return zip;
  }

  if (version !== 3) throw new Error("unsupported CRX version");
  const headerLen = buf.readUInt32LE(8);
  if (12 + headerLen > buf.length) fail("truncated");
  const header = buf.subarray(12, 12 + headerLen), zip = buf.subarray(12 + headerLen);
  let signedHeader = null, crxId = null;
  const proofs = []; // { algo, key, sig }
  try {
    for (const [field, wire, value] of readFields(header)) {
      if (wire !== 2) continue;
      if (field === 10000) signedHeader = value;
      else if (field === 2 || field === 3) {
        let key = null, sig = null;
        for (const [f, w, v] of readFields(value)) { if (w === 2 && f === 1) key = v; else if (w === 2 && f === 2) sig = v; }
        if (key && sig) proofs.push({ algo: "sha256", key, sig });
      }
    }
    if (signedHeader) crxId = (readFields(signedHeader).find(([f, w]) => f === 1 && w === 2) || [])[2];
  } catch { fail("damaged header"); }
  if (!signedHeader) fail("no signed header");
  if (!crxId || crxId.length !== 16 || idFromBytes(crxId) !== expectedId) fail("it names a different extension");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeader.length);
  const signed = Buffer.concat([SIGNED_DATA_CONTEXT, length, signedHeader, zip]);
  // The proof made with the extension's own key (the one the ID comes from) must verify.
  const own = proofs.filter(p => extensionIdFromKey(p.key) === expectedId);
  if (!own.length) fail("not signed with the extension's key");
  if (!own.some(p => verify(p.algo, signed, p.key, p.sig))) fail("bad signature");
  return zip;
}

module.exports = { crxToZip, verifyCrx, extensionIdFromKey, idFromBytes, readFields };
