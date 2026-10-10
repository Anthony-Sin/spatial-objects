const $ = id => document.getElementById(id);
const video = $('video'), view = $('view'), ctx = view.getContext('2d');
const source = document.createElement('canvas'), sourceCtx = source.getContext('2d', { willReadFrequently: true });
const depthCanvas = document.createElement('canvas'), depthCtx = depthCanvas.getContext('2d');
const params=new URLSearchParams(location.search);
const state = { stream: null, detector: null, detectorPromise: null, depthModel: null, depthPromise: null, detections: [], depth: null, frozen: false, selected: -1, pins: [], mode: 'rgb', lastDetection: 0, sourceType: 'camera', busy: false, remote: params.has('token')||(params.has('relay')&&params.has('key')), socket: null, relayClient: null, relayKey: null, remoteReady: false, paused: false, frameId: 0, busyId: 0, sentFrames: new Map(), lastResultAt: 0, latestLive: null, latestDepth: null };
const transmitCanvas = document.createElement('canvas');
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-tasks/object_detector/efficientdet_lite0_uint8.tflite';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/+esm';
const DEPTH_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

function status(message) { $('status').textContent = message; }
function badge(message) { $('modeBadge').textContent = message; }
function setStage(message) { $('stageState').textContent = message; }
function readableError(error) { return error?.message || String(error); }
function resizeView() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(view.clientWidth * dpr), height = Math.round(view.clientHeight * dpr);
  if (view.width !== width || view.height !== height) { view.width = width; view.height = height; }
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
function frameGeometry() {
  const w = view.clientWidth, h = view.clientHeight, sw = source.width || video.videoWidth, sh = source.height || video.videoHeight;
  if (!sw || !sh) return null;
  const scale = Math.min(w / sw, h / sh);
  return { x:(w-sw*scale)/2, y:(h-sh*scale)/2, w:sw*scale, h:sh*scale, scale, sw, sh };
}
function draw() {
  resizeView();
  const w=view.clientWidth,h=view.clientHeight;
  ctx.fillStyle='#0c171b';ctx.fillRect(0,0,w,h);
  const g=frameGeometry();
  if (!g) return;
  const image = state.frozen ? source : video;
  if (image === video && video.readyState < 2) return;
  ctx.drawImage(image,g.x,g.y,g.w,g.h);
  if (state.frozen && state.depth && state.mode === 'depth') {
    ctx.fillStyle='#091319'; ctx.fillRect(g.x,g.y,g.w,g.h);ctx.globalAlpha=.96;
    ctx.drawImage(depthCanvas,g.x,g.y,g.w,g.h);ctx.globalAlpha=1;
  }
  if (state.frozen && state.depth && state.mode === 'blend') drawMesh(g);
  for (const [index,d] of state.detections.entries()) drawBox(d,g,index);
  for (const pin of state.pins) drawPin(pin,g);
}
function drawBox(d,g,index) {
  const b=d.boundingBox; if(!b) return;
  const x=g.x+b.originX*g.scale,y=g.y+b.originY*g.scale,w=b.width*g.scale,h=b.height*g.scale;
  const selected=index===state.selected;
  ctx.strokeStyle=selected?'#fff5ad':'#a8ffd1'; ctx.fillStyle=selected?'#fff5ad':'#a8ffd1';ctx.lineWidth=selected?3:2;
  ctx.strokeRect(x,y,w,h);
  const label=`${d.categories?.[0]?.categoryName || 'Object'}  ${Math.round((d.categories?.[0]?.score || 0)*100)}%`;
  ctx.font='600 12px Space Grotesk, sans-serif';
  const lw=Math.min(ctx.measureText(label).width+16,Math.max(w,110));
  ctx.fillRect(x,Math.max(y-25,g.y),lw,23);
  ctx.fillStyle='#0c211b';ctx.fillText(label,x+7,Math.max(y-9,g.y+16));
  const corner=Math.min(16,w/5,h/5);ctx.strokeStyle='#eafff1';ctx.lineWidth=3;
  ctx.beginPath();ctx.moveTo(x,y+corner);ctx.lineTo(x,y);ctx.lineTo(x+corner,y);ctx.moveTo(x+w-corner,y);ctx.lineTo(x+w,y);ctx.lineTo(x+w,y+corner);ctx.stroke();
}
function drawPin(pin,g){const x=g.x+pin.x*g.scale,y=g.y+pin.y*g.scale;ctx.fillStyle='#fff1a6';ctx.beginPath();ctx.arc(x,y,6,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#112821';ctx.lineWidth=2;ctx.stroke();}
function drawMesh(g){
  const {data,width,height}=state.depth;
  const step=Math.max(26,Math.round(Math.min(g.w,g.h)/13));
  const cols=Math.ceil(g.w/step),rows=Math.ceil(g.h/step);
  const points=[];
  for(let row=0;row<=rows;row++){
    const line=[];
    for(let col=0;col<=cols;col++){
      const px=Math.min(g.w,col*g.w/cols),py=Math.min(g.h,row*g.h/rows);
      const ix=Math.min(width-1,Math.floor(px/g.w*width)),iy=Math.min(height-1,Math.floor(py/g.h*height));
      line.push({x:g.x+px,y:g.y+py,z:data[iy*width+ix]/255});
    }
    points.push(line);
  }
  ctx.lineWidth=1.05;
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    const a=points[row][col],b=points[row][col+1],c=points[row+1][col],d=points[row+1][col+1];
    const z=(a.z+b.z+c.z+d.z)/4;
    ctx.strokeStyle=`rgba(${Math.round(69+56*z)},${Math.round(220+30*z)},${Math.round(187+35*z)},${(.28+.48*z).toFixed(2)})`;
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.lineTo(d.x,d.y);ctx.lineTo(c.x,c.y);ctx.closePath();
    if((row+col)%2===0){ctx.moveTo(a.x,a.y);ctx.lineTo(d.x,d.y)}else{ctx.moveTo(b.x,b.y);ctx.lineTo(c.x,c.y)}
    ctx.stroke();
  }
}
function updateCounters(){ $('objectCount').textContent=`${state.detections.length} OBJECT${state.detections.length===1?'':'S'}`; $('resolution').textContent=source.width?`${source.width} × ${source.height}`:video.videoWidth?`${video.videoWidth} × ${video.videoHeight}`:''; }

async function loadDetector(){
  if(state.detector) return state.detector;
  if(!state.detectorPromise) state.detectorPromise=(async()=>{
    status('Loading object detector…');
    const {ObjectDetector,FilesetResolver}=await import(VISION_URL);
    const fileset=await FilesetResolver.forVisionTasks(WASM_URL);
    const detector=await ObjectDetector.createFromOptions(fileset,{baseOptions:{modelAssetPath:MODEL_URL,delegate:'CPU'},runningMode:'VIDEO',scoreThreshold:.42,maxResults:12});
    state.detector=detector;status('Object detector ready');return detector;
  })().catch(error=>{state.detectorPromise=null;throw error});
  return state.detectorPromise;
}
async function loadDepth(){
  if(state.depthModel) return state.depthModel;
  if(!state.depthPromise) state.depthPromise=(async()=>{
    $('depthState').textContent='LOADING DEPTH MODEL';status('Downloading depth model (about 27 MB)…');
    const {pipeline}=await import(DEPTH_URL);
    state.depthModel=await pipeline('depth-estimation','onnx-community/depth-anything-v2-small',{dtype:'q8',device:'wasm'});
    return state.depthModel;
  })().catch(error=>{state.depthPromise=null;throw error});
  return state.depthPromise;
}
async function startCamera(){
  if(!navigator.mediaDevices?.getUserMedia){status('Camera needs HTTPS or localhost. Try a photo.');return;}
  try{
    badge('STARTING'); status('Requesting camera access…');
    const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
    if(state.stream) state.stream.getTracks().forEach(track=>track.stop());
    state.stream=stream;video.srcObject=stream;await video.play();
    state.frozen=false;state.sourceType='camera';state.depth=null;state.detections=[];state.pins=[];state.selected=-1;source.width=0;source.height=0;
    $('empty').hidden=true;$('captureBtn').disabled=false;$('captureBtn').hidden=false;$('resumeBtn').hidden=true;$('objectPanel').hidden=true;
    badge('LIVE');setStage('LIVE CAMERA');$('depthState').textContent='DEPTH IDLE';status('Point camera at objects'); updateCounters();draw();
    if(state.remote){$('captureBtn').hidden=true;connectRemote()}
    else {loadDetector().catch(error=>status(`Object model failed: ${readableError(error)}`));requestAnimationFrame(tick)}
  }catch(error){badge('CAMERA ERROR');status(`Camera: ${readableError(error)}. Try a photo.`);}
}
function base64urlBytes(value){const base64=value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4);const binary=atob(base64);return Uint8Array.from(binary,c=>c.charCodeAt(0))}
async function encryptRelay(object){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const plaintext=new TextEncoder().encode(JSON.stringify(object));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},state.relayKey,plaintext));
  const payload=new Uint8Array(iv.length+encrypted.length);payload.set(iv);payload.set(encrypted,iv.length);return payload;
}
async function decryptRelay(payload){
  const bytes=payload instanceof Uint8Array?payload:new Uint8Array(payload);
  const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},state.relayKey,bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plaintext));
}
const CHUNK_MAX=48000,CHUNK_MAGIC=[0x53,0x50,0x4c,0x31];
const reassembly=new Map();let chunkSeq=0;
function chunkedRelay(sealed){
  if(sealed.length<=CHUNK_MAX)return[sealed];
  const id=chunkSeq=(chunkSeq+1)%65536,body=CHUNK_MAX-8,total=Math.ceil(sealed.length/body),parts=[];
  for(let i=0;i<total;i++){
    const part=sealed.subarray(i*body,(i+1)*body),packet=new Uint8Array(8+part.length);
    packet.set(CHUNK_MAGIC);packet[4]=id&255;packet[5]=id>>8;packet[6]=i;packet[7]=total;packet.set(part,8);
    parts.push(packet);
  }
  return parts;
}
function unchunkRelay(payload){
  if(payload.length<9||payload[0]!==0x53||payload[1]!==0x50||payload[2]!==0x4c||payload[3]!==0x31)return payload;
  const id=payload[4]|payload[5]<<8,idx=payload[6],total=payload[7];
  let entry=reassembly.get(id);
  if(!entry||entry.total!==total){entry={total,parts:new Map(),at:Date.now()};reassembly.set(id,entry)}
  entry.parts.set(idx,payload.subarray(8));
  if(reassembly.size>24)for(const [k,v] of reassembly){if(Date.now()-v.at>15000)reassembly.delete(k)}
  if(entry.parts.size<total)return null;
  reassembly.delete(id);
  let size=0;for(let i=0;i<total;i++)size+=entry.parts.get(i).length;
  const full=new Uint8Array(size);let off=0;
  for(let i=0;i<total;i++){const p=entry.parts.get(i);full.set(p,off);off+=p.length}
  return full;
}
async function sendRemoteMessage(message){
  if(state.relayClient){
    if(!state.relayClient.connected)throw new Error('Relay disconnected');
    const topic=`spatial/${params.get('relay')}/frames`;
    for(const part of chunkedRelay(await encryptRelay(message)))state.relayClient.publish(topic,part,{qos:0});
  } else if(state.socket?.readyState===1)state.socket.send(JSON.stringify(message));
  else throw new Error('Computer disconnected');
}
async function handleRemoteMessage(message){
  if(message.type==='hello'){
    if(message.status==='ready'){state.remoteReady=true;badge('PC LIVE');setStage('PC INFERENCE / LIVE');status('Computer is scanning live');sendRemoteFrame()}
    else if(message.status==='error'){badge('MODEL ERROR');status(message.error||'Computer model failed')}
    else {status(`Computer models: ${message.status}…`);setTimeout(()=>sendRemoteMessage({type:'status'}).catch(()=>{}),1800)}
  }
  if(message.type==='result'){
    try{await applyRemoteResult(message)}catch(error){status(`Display error: ${readableError(error)}`)}
    state.busy=false;
    if(!state.paused)setTimeout(sendRemoteFrame,80);
  }
  if(message.type==='depth'){
    try{await applyRemoteDepth(message)}catch(error){status(`Depth display error: ${readableError(error)}`)}
  }
  if(message.type==='error'){state.busy=false;status(`Computer: ${message.message}`);if(!state.paused)setTimeout(sendRemoteFrame,1000)}
}
async function connectRelay(){
  try{
    if(!window.mqtt)throw new Error('Relay library did not load');
    state.relayKey=await crypto.subtle.importKey('raw',base64urlBytes(params.get('key')),'AES-GCM',false,['encrypt','decrypt']);
    const client=window.mqtt.connect('wss://demo.tbmq.io/mqtt',{username:'demo',clientId:`spatial_phone_${Math.random().toString(36).slice(2)}`,reconnectPeriod:1500,keepalive:30});
    state.relayClient=client;
    client.on('connect',()=>{
      client.subscribe(`spatial/${params.get('relay')}/results`,error=>{
        if(error){status(`Relay subscribe: ${readableError(error)}`);return}
        sendRemoteMessage({type:'status'}).catch(error=>status(readableError(error)));
      });
    });
    client.on('message',async(topic,payload)=>{
      if(topic!==`spatial/${params.get('relay')}/results`)return;
      try{const joined=unchunkRelay(payload);if(joined)await handleRemoteMessage(await decryptRelay(joined))}catch(error){status(`Relay message: ${readableError(error)}`)}
    });
    client.on('close',()=>{state.remoteReady=false;state.busy=false;badge('RECONNECTING');status('Relay reconnecting…')});
    client.on('error',error=>status(`Relay: ${readableError(error)}`));
    setInterval(()=>{if(client.connected&&!state.remoteReady)sendRemoteMessage({type:'status'}).catch(()=>{})},3000);
  }catch(error){badge('RELAY ERROR');status(`Relay setup: ${readableError(error)}`)}
}
function connectRemote(){
  state.paused=false;state.remoteReady=false;
  badge('CONNECTING');setStage('CONNECTING TO COMPUTER');status('Connecting to computer…');
  if(params.has('relay')){connectRelay();return}
  const url=new URL('/ws',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
  url.searchParams.set('token',params.get('token'));
  const socket=new WebSocket(url);state.socket=socket;
  socket.onopen=()=>sendRemoteMessage({type:'status'}).catch(()=>{});
  socket.onmessage=event=>{try{handleRemoteMessage(JSON.parse(event.data))}catch{}};
  socket.onclose=()=>{state.remoteReady=false;state.busy=false;if(state.stream&&!state.paused){badge('RECONNECTING');status('Computer connection lost — reconnecting…');setTimeout(connectRemote,2200)}};
  socket.onerror=()=>status('Computer connection error');
}
function sendRemoteFrame(){
  if(!state.remoteReady||state.paused||state.busy||!state.stream||video.readyState<2)return;
  const scale=Math.min(1,640/Math.max(video.videoWidth,video.videoHeight));
  transmitCanvas.width=Math.max(1,Math.round(video.videoWidth*scale));transmitCanvas.height=Math.max(1,Math.round(video.videoHeight*scale));
  transmitCanvas.getContext('2d').drawImage(video,0,0,transmitCanvas.width,transmitCanvas.height);
  const id=++state.frameId,image=transmitCanvas.toDataURL('image/jpeg',.68);
  state.sentFrames.set(id,image);while(state.sentFrames.size>16)state.sentFrames.delete(state.sentFrames.keys().next().value);
  state.busy=true;state.busyId=id;
  sendRemoteMessage({type:'frame',id,image}).catch(error=>{state.busy=false;status(`Send failed: ${readableError(error)}`)});
  setTimeout(()=>{if(state.busy&&state.busyId===id){state.busy=false;if(!state.paused){status('Frame result dropped — resuming scan');sendRemoteFrame()}}},7000);
}
async function decodeRemoteFrame(message){
  const sent=message.image||state.sentFrames.get(message.id);
  if(!sent)return null;
  const image=new Image();image.src=sent;await image.decode();
  const detections=(message.detections||[]).map(d=>({categories:[{categoryName:d.label,score:d.score}],boundingBox:{originX:d.box.xmin,originY:d.box.ymin,width:d.box.xmax-d.box.xmin,height:d.box.ymax-d.box.ymin}}));
  let depth=null;
  if(message.depth){const binary=atob(message.depth.data),pixels=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)pixels[i]=binary.charCodeAt(i);depth={data:pixels,width:message.depth.width,height:message.depth.height}}
  return {image,width:message.width,height:message.height,detections,depth};
}
function displayRemoteFrame(frame){
  if(!frame)return;
  source.width=frame.width;source.height=frame.height;sourceCtx.drawImage(frame.image,0,0);
  state.frozen=true;state.detections=frame.detections;state.depth=frame.depth;
  if(frame.depth)colorizeDepth(frame.depth);
  updateCounters();draw();
}
async function applyRemoteResult(message){
  const frame=await decodeRemoteFrame(message);if(!frame)return;
  state.latestLive=frame;
  if(!state.paused&&state.mode==='rgb')displayRemoteFrame(frame);
  state.lastResultAt=performance.now();
}
async function applyRemoteDepth(message){
  const frame=await decodeRemoteFrame(message);if(!frame)return;
  state.latestDepth=frame;
  $('depthState').textContent='LIVE RELATIVE DEPTH';
  if(!state.paused&&state.mode!=='rgb')displayRemoteFrame(frame);
}
function tick(timestamp){
  if(state.frozen||!state.stream)return;
  if(video.readyState>=2 && state.detector && timestamp-state.lastDetection>220){
    try{state.detections=state.detector.detectForVideo(video,performance.now()).detections || [];updateCounters();state.lastDetection=timestamp;}catch(error){status(`Detection: ${readableError(error)}`)}
  }
  draw();requestAnimationFrame(tick);
}
function captureFrame(){
  if(!video.videoWidth||state.busy)return;
  source.width=video.videoWidth;source.height=video.videoHeight;sourceCtx.drawImage(video,0,0,source.width,source.height);
  freezeAndAnalyze();
}
async function freezeAndAnalyze(){
  state.frozen=true;state.busy=true;state.depth=null;state.selected=-1;state.pins=[];
  $('empty').hidden=true;$('captureBtn').hidden=true;$('resumeBtn').hidden=false;$('resumeBtn').disabled=true;
  $('resumeBtn').textContent=state.sourceType==='camera'?'↺   Live camera':'↺   Try another photo';$('objectPanel').hidden=true;
  badge('SCANNING');setStage('CAPTURED FRAME');$('depthState').textContent='ESTIMATING DEPTH';updateCounters();draw();
  try{
    const detector=await loadDetector();
    await detector.setOptions({runningMode:'IMAGE'});
    state.detections=detector.detect(source).detections||[];
    await detector.setOptions({runningMode:'VIDEO'});
    updateCounters();draw();
  }catch(error){state.detections=[];updateCounters();status(`Object scan failed: ${readableError(error)}`)}
  try{
    const model=await loadDepth();
    const input=document.createElement('canvas');const scale=Math.min(1,384/Math.max(source.width,source.height));
    input.width=Math.max(1,Math.round(source.width*scale));input.height=Math.max(1,Math.round(source.height*scale));
    input.getContext('2d').drawImage(source,0,0,input.width,input.height);
    status('Estimating depth from captured frame…');
    const result=await model(input);
    const raw=result.depth;
    state.depth={data:raw.data,width:raw.width,height:raw.height};
    colorizeDepth(raw);$('depthState').textContent='RELATIVE DEPTH READY';status('Scan ready — tap an object');
    badge('SCAN READY');
  }catch(error){$('depthState').textContent='DEPTH UNAVAILABLE';badge('PARTIAL SCAN');status(`Depth unavailable: ${readableError(error)}`)}
  state.busy=false;$('resumeBtn').disabled=false;draw();
}
function colorizeDepth(raw){
  depthCanvas.width=raw.width;depthCanvas.height=raw.height;
  const image=depthCtx.createImageData(raw.width,raw.height);
  for(let i=0;i<raw.data.length;i++){
    const v=raw.data[i]/255;const j=i*4;
    image.data[j]=Math.round(24+185*v);image.data[j+1]=Math.round(45+210*Math.sin(Math.PI*v));image.data[j+2]=Math.round(165-130*v);image.data[j+3]=255;
  }
  depthCtx.putImageData(image,0,0);
}
function relativeDepth(box){
  if(!state.depth)return 'Unavailable';
  const {data,width,height}=state.depth;const x0=Math.max(0,Math.floor((box.originX+box.width*.25)/source.width*width));
  const x1=Math.min(width,Math.ceil((box.originX+box.width*.75)/source.width*width));
  const y0=Math.max(0,Math.floor((box.originY+box.height*.25)/source.height*height));
  const y1=Math.min(height,Math.ceil((box.originY+box.height*.75)/source.height*height));
  let sum=0,n=0;for(let y=y0;y<y1;y+=Math.max(1,Math.floor((y1-y0)/20)))for(let x=x0;x<x1;x+=Math.max(1,Math.floor((x1-x0)/20))){sum+=data[y*width+x];n++}
  return n?`${Math.round(sum/n/255*100)} / 100`:'Unavailable';
}
function selectObject(index){
  state.selected=index;const d=state.detections[index];const c=d.categories?.[0]||{};
  $('objectName').textContent=c.categoryName||'Object';$('confidence').textContent=`${Math.round((c.score||0)*100)}%`;
  $('objectDepth').textContent=relativeDepth(d.boundingBox);$('objectPanel').hidden=false;draw();
  if(window.innerWidth>620)$('objectPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function nearestDetection(x,y,g){
  let match=-1,area=Infinity;
  const tolerance=32/g.scale;
  state.detections.forEach((d,i)=>{const b=d.boundingBox;if(!b)return;
    if(x>=b.originX-tolerance&&x<=b.originX+b.width+tolerance&&y>=b.originY-tolerance&&y<=b.originY+b.height+tolerance){
      const a=b.width*b.height;if(a<area){match=i;area=a}
    }
  });
  return match;
}
view.addEventListener('pointerdown',async event=>{
  const g=frameGeometry();if(!g)return;
  const rect=view.getBoundingClientRect(),x=(event.clientX-rect.left-g.x)/g.scale,y=(event.clientY-rect.top-g.y)/g.scale;
  if(x<0||y<0||x>g.sw||y>g.sh)return;
  if(!state.remote&&!state.frozen&&state.detector){
    source.width=video.videoWidth;source.height=video.videoHeight;sourceCtx.drawImage(video,0,0);state.frozen=true;
    try{await state.detector.setOptions({runningMode:'IMAGE'});state.detections=state.detector.detect(source).detections||[];await state.detector.setOptions({runningMode:'VIDEO'})}catch(error){status(`Tap scan: ${readableError(error)}`)}
    $('captureBtn').hidden=true;$('resumeBtn').hidden=false;$('resumeBtn').textContent='↺   Continue live scan';updateCounters();draw();
  }
  const match=nearestDetection(x,y,g);
  if(match>=0){if(state.remote){state.paused=true;$('resumeBtn').hidden=false;$('resumeBtn').textContent='↺   Continue live scan';setStage('OBJECT SELECTED / PAUSED')}selectObject(match)}
  else status('No detected object at that point — try another angle or lighting');
});
function setMode(mode){
  state.mode=mode;for(const name of ['rgb','depth','blend']){$(`${name}Btn`).classList.toggle('selected',name===mode);$(`${name}Btn`).setAttribute('aria-pressed',String(name===mode))}
  if(state.remote){state.selected=-1;$('objectPanel').hidden=true;displayRemoteFrame(mode==='rgb'?state.latestLive:state.latestDepth);if(mode!=='rgb'&&!state.latestDepth)status('Waiting for the next aligned depth frame…');return}
  if(mode!=='rgb'&&!state.depth)status(state.frozen?'Depth is still loading or unavailable':'Scan a frame to estimate depth');draw();
}
async function usePhoto(file){
  if(!file)return;try{
    badge('PHOTO');status('Reading photo…');const bitmap=await createImageBitmap(file);
    source.width=bitmap.width;source.height=bitmap.height;sourceCtx.drawImage(bitmap,0,0);bitmap.close();
    state.sourceType='photo';if(state.stream){state.stream.getTracks().forEach(track=>track.stop());state.stream=null}
    await freezeAndAnalyze();
  }catch(error){status(`Photo failed: ${readableError(error)}`)}
}
$('startBtn').addEventListener('click',startCamera);
$('uploadBtn').addEventListener('click',()=>$('fileInput').click());
$('fileInput').addEventListener('change',event=>usePhoto(event.target.files?.[0]));
$('captureBtn').addEventListener('click',captureFrame);
$('resumeBtn').addEventListener('click',()=>{if(state.sourceType==='photo'){$('fileInput').click();return}state.selected=-1;state.pins=[];$('objectPanel').hidden=true;$('resumeBtn').hidden=true;if(state.remote){state.paused=false;badge('PC LIVE');setStage('PC INFERENCE / LIVE');sendRemoteFrame();return}state.frozen=false;state.depth=null;$('captureBtn').hidden=false;badge('LIVE');setStage('LIVE CAMERA');$('depthState').textContent='DEPTH IDLE';setMode('rgb');requestAnimationFrame(tick)});
for(const mode of ['rgb','depth','blend'])$(`${mode}Btn`).addEventListener('click',()=>setMode(mode));
$('closePanel').addEventListener('click',()=>{state.selected=-1;$('objectPanel').hidden=true;draw()});
$('anchorBtn').addEventListener('click',()=>{const b=state.detections[state.selected]?.boundingBox;if(!b)return;state.pins.push({x:b.originX+b.width/2,y:b.originY+b.height/2});status('Pin attached to this captured frame');draw()});
$('copyBtn').addEventListener('click',async()=>{const label=$('objectName').textContent;try{await navigator.clipboard.writeText(label);status(`Copied “${label}”`)}catch{status('Clipboard unavailable')}});
$('shareBtn').addEventListener('click',async()=>{const label=$('objectName').textContent;try{if(navigator.share)await navigator.share({title:'Spatial Objects scan',text:`I scanned ${label} with Spatial Objects.`});else{await navigator.clipboard.writeText(`Spatial Objects: ${label}`);status('Object label copied')}}catch(error){if(error.name!=='AbortError')status(`Share failed: ${readableError(error)}`)}});
window.addEventListener('resize',draw);
window.addEventListener('pagehide',()=>{state.stream?.getTracks().forEach(track=>track.stop());state.socket?.close();state.relayClient?.end(true)});
if(state.remote)$('processingNote').innerHTML='<b>Computer processing.</b> Camera frames are encrypted on this phone and relayed to your computer for object detection and relative depth. The view displays each processed frame with matching overlays. The session link contains the encryption key; keep it private.';
draw();
