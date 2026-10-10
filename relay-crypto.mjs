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

// The relay broker drops connections above a 64 KB packet, so larger sealed
// payloads are split into 'SPL1'-framed chunks: magic(4) msgId(2) idx(1) total(1).
const CHUNK_MAX=48000;
let chunkSeq=0;
export function chunkSeal(bytes, max = CHUNK_MAX) {
  const data=Buffer.from(bytes);
  if(data.length<=max)return[data];
  const id=chunkSeq=(chunkSeq+1)%65536;
  const body=max-8,total=Math.ceil(data.length/body),parts=[];
  for(let i=0;i<total;i++){
    const part=data.subarray(i*body,(i+1)*body);
    parts.push(Buffer.concat([Buffer.from([0x53,0x50,0x4c,0x31,id&255,id>>8,i,total]),part]));
  }
  return parts;
}
export function joinChunks(pending, payload) {
  const data=Buffer.from(payload);
  if(data.length<9||data.readUInt32BE(0)!==0x53504c31)return data;
  const id=data.readUInt16BE(4),idx=data[6],total=data[7];
  let entry=pending.get(id);
  if(!entry||entry.total!==total){entry={total,parts:new Map(),at:Date.now()};pending.set(id,entry)}
  entry.parts.set(idx,data.subarray(8));
  if(pending.size>24){for(const [k,v] of pending){if(Date.now()-v.at>15000)pending.delete(k)}}
  if(entry.parts.size<total)return null;
  pending.delete(id);
  return Buffer.concat([...Array(total).keys()].map(i=>entry.parts.get(i)));
}
