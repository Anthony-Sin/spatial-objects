import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import QRCode from 'qrcode';

const root=join(import.meta.dirname,'..');
const relay=randomBytes(12).toString('hex');
const key=randomBytes(32).toString('base64url');
const publicBase=process.env.SPATIAL_PUBLIC_URL || 'https://anthony-sin.github.io/spatial-objects/';
const url=new URL(publicBase);url.searchParams.set('relay',relay);url.searchParams.set('key',key);
await QRCode.toFile(join(root,'live-qr.png'),url.href,{width:560,margin:3,color:{dark:'#10231e',light:'#ffffff'}});

const server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,SPATIAL_RELAY:relay,SPATIAL_KEY:key},stdio:['ignore','pipe','pipe']});
server.stdout.on('data',chunk=>process.stdout.write(`[computer] ${chunk}`));
server.stderr.on('data',chunk=>process.stderr.write(`[computer] ${chunk}`));
server.on('exit',code=>{console.error(`Computer processor exited (${code})`);process.exit(code||1)});
process.on('SIGINT',()=>{server.kill('SIGINT');process.exit(0)});
process.on('SIGTERM',()=>{server.kill('SIGTERM');process.exit(0)});

console.log(`\nLIVE PHONE LINK: ${url.href}`);
console.log(`QR FILE: ${join(root,'live-qr.png')}`);
console.log('Keep this process running while you use the phone.\n');
