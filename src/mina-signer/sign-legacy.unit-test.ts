import {
  payments,
  delegations,
  strings,
  keypair,
  signatures,
} from './test-vectors/legacySignatures.js';
import { signPayment, signStakeDelegation, signString } from './sign-legacy.js';
import { NetworkId, Signature } from './signature.js';
import { expect } from 'expect';

let { privateKey } = keypair;
let networks: NetworkId[] = ['testnet', 'mainnet'];

for (let network of networks) {
  let i = 0;
  let reference = signatures[network];

  for (let payment of payments) {
    let signatureBase58 = signPayment(payment, privateKey, network);
    let signature = Signature.fromBase58(signatureBase58);
    let ref = reference[i++];
    expect(signature.r).toEqual(BigInt(ref.field));
    expect(signature.s).toEqual(BigInt(ref.scalar));
  }

  for (let delegation of delegations) {
    let signatureBase58 = signStakeDelegation(delegation, privateKey, network);
    let signature = Signature.fromBase58(signatureBase58);
    let ref = reference[i++];
    expect(signature.r).toEqual(BigInt(ref.field));
    expect(signature.s).toEqual(BigInt(ref.scalar));
  }

  for (let string of strings) {
    let signatureBase58 = signString(string, privateKey, network);
    let signature = Signature.fromBase58(signatureBase58);
    let ref = reference[i++];
    expect(signature.r).toEqual(BigInt(ref.field));
    expect(signature.s).toEqual(BigInt(ref.scalar));
  }
}

console.log('legacy signatures match the test vectors! 🎉');
process.exit(0);
