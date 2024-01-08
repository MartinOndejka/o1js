// https://csrc.nist.gov/pubs/fips/180-4/upd1/final
import { mod } from '../../bindings/crypto/finite_field.js';
import { Field } from '../core.js';
import { UInt32, UInt8 } from '../int.js';
import { FlexibleBytes } from '../provable-types/bytes.js';
import { Bytes } from '../provable-types/provable-types.js';
import { chunk } from '../util/arrays.js';
import { TupleN } from '../util/types.js';
import { bytesToWord, wordToBytes } from './bit-slices.js';
import { bitSlice, exists } from './common.js';
import { Gadgets } from './gadgets.js';
import { rangeCheck16 } from './range-check.js';

export { SHA256 };

const SHA256Constants = {
  // constants §4.2.2
  K: [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ],
  // initial hash values §5.3.3
  H: [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ],
};

function padding(data: FlexibleBytes): UInt32[][] {
  // create a provable Bytes instance from the input data
  // the Bytes class will be static sized according to the length of the input data
  let message = Bytes.from(data);

  // now pad the data to reach the format expected by sha256
  // pad 1 bit, followed by k zero bits where k is the smallest non-negative solution to
  // l + 1 + k = 448 mod 512
  // then append a 64bit block containing the length of the original message in bits

  let l = message.length * 8; // length in bits
  let k = Number(mod(448n - (BigInt(l) + 1n), 512n));

  let paddingBits = (
    '1' + // append 1 bit
    '0'.repeat(k) + // append k zero bits
    '0'.repeat(64 - l.toString(2).length) + // append 64bit containing the length of the original message
    l.toString(2)
  ).match(/.{1,8}/g)!; // this should always be devisable by 8

  // map the padding bit string to UInt8 elements
  let padding = paddingBits.map((x) => UInt8.from(BigInt('0b' + x)));

  // concatenate the padding with the original padded data
  let paddedMessage = message.bytes.concat(padding);

  // split the message into 32bit chunks
  let chunks: UInt32[] = [];

  for (let i = 0; i < paddedMessage.length; i += 4) {
    // chunk 4 bytes into one UInt32, as expected by SHA256
    // bytesToWord expects little endian, so we reverse the bytes
    chunks.push(
      UInt32.from(bytesToWord(paddedMessage.slice(i, i + 4).reverse()))
    );
  }

  // split message into 16 element sized message blocks
  // SHA256 expects n-blocks of 512bit each, 16*32bit = 512bit
  return chunk(chunks, 16);
}

// decompose a 32bit word into 4 bytes
function decomposeToBytes(a: UInt32) {
  let field = a.value;
  let ys = [];
  for (let i = 0; i < 4; i++) {
    // for each byte we rotate the element and get the excess bits (8 at a time) and construct a UInt8 of it
    let { quotient, remainder } = Gadgets.divMod32(field.mul(1n << 8n));
    // "shift" the element by 8 bit to get the next byte sequence during the next iteration
    field = remainder;
    ys.push(quotient);
  }

  // UInt8.from does a rangeCheck8 for Field elements
  return ys.map(UInt8.from);
}

const SHA256 = {
  hash(data: FlexibleBytes) {
    // preprocessing §6.2
    // padding the message $5.1.1 into blocks that are a multiple of 512
    let messageBlocks = padding(data);

    const H = SHA256Constants.H.map((x) => UInt32.from(x));
    const K = SHA256Constants.K.map((x) => UInt32.from(x));

    const N = messageBlocks.length;

    for (let i = 0; i < N; i++) {
      const M = messageBlocks[i];
      // for each message block of 16 x 32bit do:
      const W: UInt32[] = [];

      // prepare message block
      for (let t = 0; t <= 15; t++) W[t] = M[t];
      for (let t = 16; t <= 63; t++) {
        // the field element is unreduced and not proven to be 32bit, we will do this later to save constraints
        let unreduced = DeltaOne(W[t - 2])
          .value.add(W[t - 7].value)
          .add(DeltaZero(W[t - 15]).value.add(W[t - 16].value));

        // mod 32bit the unreduced field element
        W[t] = UInt32.from(Gadgets.divMod32(unreduced, 16).remainder);
      }

      // initialize working variables
      let a = H[0];
      let b = H[1];
      let c = H[2];
      let d = H[3];
      let e = H[4];
      let f = H[5];
      let g = H[6];
      let h = H[7];

      // main loop
      for (let t = 0; t <= 63; t++) {
        // T1 is unreduced and not proven to be 32bit, we will do this later to save constraints
        const unreducedT1 = h.value
          .add(SigmaOne(e).value)
          .add(Ch(e, f, g).value)
          .add(K[t].value)
          .add(W[t].value);

        // T2 is also unreduced
        const unreducedT2 = SigmaZero(a).value.add(Maj(a, b, c).value);

        h = g;
        g = f;
        f = e;
        e = UInt32.from(
          Gadgets.divMod32(d.value.add(unreducedT1), 16).remainder
        ); // mod 32bit the unreduced field element
        d = c;
        c = b;
        b = a;
        a = UInt32.from(
          Gadgets.divMod32(unreducedT2.add(unreducedT1), 16).remainder
        ); // mod 32bit
      }

      // new intermediate hash value
      H[0] = H[0].addMod32(a);
      H[1] = H[1].addMod32(b);
      H[2] = H[2].addMod32(c);
      H[3] = H[3].addMod32(d);
      H[4] = H[4].addMod32(e);
      H[5] = H[5].addMod32(f);
      H[6] = H[6].addMod32(g);
      H[7] = H[7].addMod32(h);
    }

    // the working variables H[i] are 32bit, however we want to decompose them into bytes to be more compatible
    // wordToBytes expects little endian, so we reverse the bytes
    return Bytes.from(H.map((x) => wordToBytes(x.value, 4).reverse()).flat());
  },
};

function Ch(x: UInt32, y: UInt32, z: UInt32) {
  // ch(x, y, z) = (x & y) ^ (~x & z)
  //             = (x & y) + (~x & z) (since x & ~x = 0)
  let xAndY = x.and(y).value;
  let xNotAndZ = x.not().and(z).value;
  let ch = xAndY.add(xNotAndZ).seal();
  return UInt32.from(ch);
}

function Maj(x: UInt32, y: UInt32, z: UInt32) {
  // maj(x, y, z) = (x & y) ^ (x & z) ^ (y & z)
  //              = (x + y + z - (x ^ y ^ z)) / 2
  let sum = x.value.add(y.value).add(z.value).seal();
  let xor = x.xor(y).xor(z).value;
  let maj = sum.sub(xor).div(2).seal();
  return UInt32.from(maj);
}

function SigmaZero(x: UInt32) {
  return sigma(x, [2, 13, 22]);
}

function SigmaOne(x: UInt32) {
  return sigma(x, [6, 11, 25]);
}

// lowercase sigma = delta to avoid confusing function names

function DeltaZero(x: UInt32) {
  return sigma(x, [3, 7, 18], true);
}

function DeltaOne(x: UInt32) {
  return sigma(x, [10, 17, 19], true);
}

function ROTR(n: number, x: UInt32) {
  return x.rotate(n, 'right');
}

function SHR(n: number, x: UInt32) {
  let val = x.rightShift(n);
  return val;
}

function sigmaSimple(u: UInt32, bits: TupleN<number, 3>, firstShifted = false) {
  let [r0, r1, r2] = bits;
  let rot0 = firstShifted ? SHR(r0, u) : ROTR(r0, u);
  let rot1 = ROTR(r1, u);
  let rot2 = ROTR(r2, u);
  return rot0.xor(rot1).xor(rot2);
}

function sigma(u: UInt32, bits: TupleN<number, 3>, firstShifted = false) {
  if (u.isConstant()) return sigmaSimple(u, bits, firstShifted);

  let [r0, r1, r2] = bits; // TODO assert bits are sorted
  let x = u.value;

  let d0 = r0;
  let d1 = r1 - r0;
  let d2 = r2 - r1;
  let d3 = 32 - r2;

  // decompose x into 4 chunks of size d0, d1, d2, d3
  let [x0, x1, x2, x3] = exists(4, () => {
    let xx = x.toBigInt();
    return [
      bitSlice(xx, 0, d0),
      bitSlice(xx, r0, d1),
      bitSlice(xx, r1, d2),
      bitSlice(xx, r2, d3),
    ];
  });

  // range check each chunk
  // we only need to range check to 16 bits relying on the requirement that
  // the rotated values are range-checked to 32 bits later; see comments below
  rangeCheck16(x0);
  rangeCheck16(x1);
  rangeCheck16(x2);
  rangeCheck16(x3);

  // prove x decomposition

  // x === x0 + x1*2^d0 + x2*2^(d0+d1) + x3*2^(d0+d1+d2)
  let x23 = x2.add(x3.mul(1 << d2)).seal();
  let x123 = x1.add(x23.mul(1 << d1)).seal();
  x0.add(x123.mul(1 << d0)).assertEquals(x);
  // ^ proves that 2^(32-d3)*x3 < x < 2^32 => x3 < 2^d3

  // reassemble chunks into rotated values

  let xRotR0: Field;

  if (!firstShifted) {
    // rotr(x, r0) = x1 + x2*2^d1 + x3*2^(d1+d2) + x0*2^(d1+d2+d3)
    xRotR0 = x123.add(x0.mul(1 << (d1 + d2 + d3))).seal();
    // ^ proves that 2^(32-d0)*x0 < xRotR0 => x0 < 2^d0 if we check xRotR0 < 2^32 later
  } else {
    // shr(x, r0) = x1 + x2*2^d1 + x3*2^(d1+d2)
    xRotR0 = x123;

    // finish x0 < 2^d0 proof:
    rangeCheck16(x0.mul(1 << (16 - d0)).seal());
  }

  // rotr(x, r1) = x2 + x3*2^d2 + x0*2^(d2+d3) + x1*2^(d2+d3+d0)
  let x01 = x0.add(x1.mul(1 << d0)).seal();
  let xRotR1 = x23.add(x01.mul(1 << (d2 + d3))).seal();
  // ^ proves that 2^(32-d1)*x1 < xRotR1 => x1 < 2^d1 if we check xRotR1 < 2^32 later

  // rotr(x, r2) = x3 + x0*2^d3 + x1*2^(d3+d0) + x2*2^(d3+d0+d1)
  let x012 = x01.add(x2.mul(1 << (d0 + d1))).seal();
  let xRotR2 = x3.add(x012.mul(1 << d3)).seal();
  // ^ proves that 2^(32-d2)*x2 < xRotR2 => x2 < 2^d2 if we check xRotR2 < 2^32 later

  return UInt32.from(xRotR0).xor(new UInt32(xRotR1)).xor(new UInt32(xRotR2));
}
