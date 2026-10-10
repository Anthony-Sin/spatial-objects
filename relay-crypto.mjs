import { randomBytes, webcrypto } from 'node:crypto';

export async function relayKey(secret) {
  return webcrypto.subtle.importKey('raw',Buffer.from(secret,'base64url'),'AES-GCM',false,['encrypt','decrypt']);
}
export async function seal(key, object) {
  const iv=randomBytes(12);
  const plaintext=new TextEncoder().encode(JSON.stringify(object));
  const ciphertext=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,plaintext);
  return Buffer.concat([iv,Buffer.from(ciphertext)]);
}
export async function unseal(key, bytes) {
  const data=Buffer.from(bytes);
  if(data.length<29)throw new Error('Encrypted message too short');
  const plaintext=await webcrypto.subtle.decrypt({name:'AES-GCM',iv:data.subarray(0,12)},key,data.subarray(12));
  return JSON.parse(new TextDecoder().decode(plaintext));
}
