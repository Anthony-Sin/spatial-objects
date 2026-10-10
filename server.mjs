import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';
import sharp from 'sharp';
import ort from 'onnxruntime-node';
import mqtt from 'mqtt';
import { relayKey, seal, unseal } from './relay-crypto.mjs';

const port = Number(process.env.PORT || 8791);
const token = process.env.SPATIAL_TOKEN || randomBytes(18).toString('base64url');
const root = join(import.meta.dirname, 'dist');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png' };
let detector, depthEstimator, RawImage, modelError, labels;
let modelState = 'loading';
const send = (socket, object) => socket.readyState === 1 && socket.send(JSON.stringify(object));

async function loadModels() {
  try {
    const transformers = await import('@huggingface/transformers');
    RawImage = transformers.RawImage;
    labels=JSON.parse(await readFile(join(import.meta.dirname,'model-labels.json'),'utf8'));
    detector=await ort.InferenceSession.create(join(import.meta.dirname,'tools/yolov8n.onnx'),{executionProviders:['cpu'],intraOpNumThreads:4,interOpNumThreads:1});
    modelState = 'loading depth';
    depthEstimator = await transformers.pipeline('depth-estimation','onnx-community/depth-anything-v2-small',{dtype:'uint8',device:'cpu'});
    depthEstimator.processor.components.image_processor.config.size={height:168,width:168};
    modelState = 'ready';
    console.log('Models ready: YOLOv8 Nano + Depth Anything V2 Small (168px input)');
  } catch (error) {
    modelError = error.message || String(error);
    modelState = 'error';
    console.error('Model initialization failed:', error);
  }
}

function overlap(a,b){
  const left=Math.max(a.box.xmin,b.box.xmin),top=Math.max(a.box.ymin,b.box.ymin);
  const right=Math.min(a.box.xmax,b.box.xmax),bottom=Math.min(a.box.ymax,b.box.ymax);
  const shared=Math.max(0,right-left)*Math.max(0,bottom-top);
  const aa=(a.box.xmax-a.box.xmin)*(a.box.ymax-a.box.ymin);
  const ba=(b.box.xmax-b.box.xmin)*(b.box.ymax-b.box.ymin);
  return shared/(aa+ba-shared||1);
}
async function detectObjects(bytes,width,height){
  const scale=Math.min(640/width,640/height),rw=Math.round(width*scale),rh=Math.round(height*scale);
  const left=Math.floor((640-rw)/2),top=Math.floor((640-rh)/2);
  const rgb=await sharp(bytes).resize(rw,rh).extend({left,right:640-rw-left,top,bottom:640-rh-top,background:{r:114,g:114,b:114}}).removeAlpha().raw().toBuffer();
  const plane=640*640,input=new Float32Array(plane*3);
  for(let i=0;i<plane;i++){input[i]=rgb[i*3]/255;input[i+plane]=rgb[i*3+1]/255;input[i+plane*2]=rgb[i*3+2]/255}
  const output=await detector.run({images:new ort.Tensor('float32',input,[1,3,640,640])});
  const values=output.output0.data,n=output.output0.dims[2],candidates=[];
  for(let i=0;i<n;i++){
    let score=0,category=-1;
    for(let k=0;k<labels.length;k++){const value=values[(k+4)*n+i];if(value>score){score=value;category=k}}
    if(score<.28)continue;
    const cx=values[i],cy=values[n+i],bw=values[n*2+i],bh=values[n*3+i];
    const box={xmin:Math.max(0,(cx-bw/2-left)/scale),ymin:Math.max(0,(cy-bh/2-top)/scale),xmax:Math.min(width,(cx+bw/2-left)/scale),ymax:Math.min(height,(cy+bh/2-top)/scale)};
    if(box.xmax<=box.xmin||box.ymax<=box.ymin)continue;
    candidates.push({label:labels[category],score,box});
  }
  candidates.sort((a,b)=>b.score-a.score);
  const kept=[];for(const candidate of candidates){if(kept.length>=16)break;if(kept.every(other=>other.label!==candidate.label||overlap(candidate,other)<.48))kept.push(candidate)}
  return kept;
}

function sampleDepth(raw, maxWidth = 160) {
  const width = Math.min(maxWidth, raw.width);
  const height = Math.max(1, Math.round(raw.height * width / raw.width));
  const pixels = Buffer.alloc(width * height);
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const sx=Math.min(raw.width-1,Math.floor(x/width*raw.width));
    const sy=Math.min(raw.height-1,Math.floor(y/height*raw.height));
    pixels[y*width+x]=raw.data[sy*raw.width+sx];
  }
  return { width, height, data:pixels.toString('base64') };
}

async function decodeFrame(message) {
  if (typeof message.image !== 'string' || !message.image.startsWith('data:image/jpeg;base64,')) throw new Error('JPEG frame required');
  const bytes=Buffer.from(message.image.slice('data:image/jpeg;base64,'.length),'base64');
  if (bytes.length > 900_000 || bytes.length < 100) throw new Error('Frame size out of range');
  const image=await RawImage.read(new Blob([bytes],{type:'image/jpeg'}));
  return {image,bytes};
}

const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,`http://${req.headers.host}`);
    if (url.pathname === '/health') {
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify({status:modelState,error:modelError||null}));return;
    }
    if (url.pathname === '/' && url.searchParams.get('token') !== token) {
      res.writeHead(403,{'content-type':'text/plain'});res.end('Open the full QR link, including its token.');return;
    }
    const path=normalize(url.pathname).replace(/^\/+/, '');
    if (path.startsWith('..') || path.includes('/..')) throw new Error('Invalid path');
    const filename=join(root,path || 'index.html');
    const body=await readFile(filename);
    res.writeHead(200,{'content-type':mime[extname(filename)]||'application/octet-stream','cache-control':'no-store'});res.end(body);
  } catch(error) {res.writeHead(404);res.end('Not found')}
});

const wss=new WebSocketServer({noServer:true,maxPayload:1_300_000});
server.on('upgrade',(req,socket,head)=>{
  const url=new URL(req.url,`http://${req.headers.host}`);
  if(url.pathname!=='/ws'||url.searchParams.get('token')!==token){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return}
  wss.handleUpgrade(req,socket,head,client=>wss.emit('connection',client));
});
function makeProcessor(sendMessage){
  let busy=false,depthBusy=false,lastDepthAt=0;
  return async message=>{
    if(message.type==='status'){sendMessage({type:'hello',status:modelState,error:modelError||null});return}
    if(message.type!=='frame'||busy||modelState!=='ready')return;
    busy=true;
    try{
      const {image,bytes}=await decodeFrame(message);
      const detections=await detectObjects(bytes,image.width,image.height);
      const common={id:message.id,width:image.width,height:image.height,detections,timestamp:Date.now()};
      sendMessage({type:'result',...common});
      if(!depthBusy && Date.now()-lastDepthAt>4000){
        depthBusy=true;lastDepthAt=Date.now();
        depthEstimator(image).then(result=>sendMessage({type:'depth',...common,depth:sampleDepth(result.depth)}))
          .catch(error=>sendMessage({type:'error',message:`Depth: ${error.message||String(error)}`}))
          .finally(()=>{depthBusy=false});
      }
    }catch(error){sendMessage({type:'error',message:error.message||String(error)})}
    finally{busy=false}
  };
}
wss.on('connection',socket=>{
  const handler=makeProcessor(object=>send(socket,object));
  send(socket,{type:'hello',status:modelState,error:modelError||null});
  socket.on('message',raw=>{try{handler(JSON.parse(raw))}catch{}});
});

async function startRelay(){
  const relay=process.env.SPATIAL_RELAY,secret=process.env.SPATIAL_KEY;
  if(!relay||!secret)return;
  const key=await relayKey(secret);
  const inputTopic=`spatial/${relay}/frames`,outputTopic=`spatial/${relay}/results`;
  const client=mqtt.connect('wss://demo.tbmq.io/mqtt',{username:'demo',clientId:`spatial_pc_${randomBytes(7).toString('hex')}`,reconnectPeriod:1500,keepalive:30});
  const sendMessage=async object=>{
    try{client.publish(outputTopic,await seal(key,object),{qos:0})}
    catch(error){console.error('Relay publish failed:',error.message)}
  };
  const handle=makeProcessor(sendMessage);
  client.on('connect',()=>{client.subscribe(inputTopic,error=>{if(error)console.error('Relay subscribe failed:',error.message);else console.log('Relay connected and listening')})});
  client.on('message',async(topic,payload)=>{
    if(topic!==inputTopic)return;
    try{await handle(await unseal(key,payload))}catch(error){console.error('Relay message failed:',error.message)}
  });
  client.on('error',error=>console.error('Relay connection:',error.message));
}

server.listen(port,'127.0.0.1',()=>{
  console.log(`Local server: http://127.0.0.1:${port}/?token=${token}`);
  console.log(`Health: http://127.0.0.1:${port}/health`);
  loadModels();
  startRelay().catch(error=>console.error('Relay startup:',error));
});
