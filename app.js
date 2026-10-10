const $ = id => document.getElementById(id);
const video = $('video'), view = $('view'), ctx = view.getContext('2d');
const source = document.createElement('canvas'), sourceCtx = source.getContext('2d', { willReadFrequently: true });
const depthCanvas = document.createElement('canvas'), depthCtx = depthCanvas.getContext('2d');
const state = { stream: null, detector: null, detectorPromise: null, depthModel: null, depthPromise: null, detections: [], depth: null, frozen: false, selected: -1, pins: [], mode: 'rgb', lastDetection: 0, sourceType: 'camera', busy: false };
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-tasks/object_detector/efficientdet_lite0_uint8.tflite';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/+esm';
const DEPTH_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

function status(message) { $('status').textContent = message; }
function badge(message) { $('modeBadge').textContent = message; }
function setStage(message) { $('stageState').textContent = message; }
function readableError(error) { return error?.message || String(error); }
function roundRect(x,y,w,h,r) { ctx.beginPath(); ctx.roundRect(x,y,w,h,r); }
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
  if (state.frozen && state.depth && state.mode !== 'rgb') {
    if (state.mode === 'depth') { ctx.fillStyle='#091319'; ctx.fillRect(g.x,g.y,g.w,g.h); ctx.globalAlpha=.96; }
    else ctx.globalAlpha=.59;
    ctx.drawImage(depthCanvas,g.x,g.y,g.w,g.h);
    ctx.globalAlpha=1;
  }
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
    loadDetector().catch(error=>status(`Object model failed: ${readableError(error)}`));
    requestAnimationFrame(tick);
  }catch(error){badge('CAMERA ERROR');status(`Camera: ${readableError(error)}. Try a photo.`);}
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
  $('objectPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
}
view.addEventListener('click',event=>{
  const g=frameGeometry();if(!g)return;
  const rect=view.getBoundingClientRect(),x=(event.clientX-rect.left-g.x)/g.scale,y=(event.clientY-rect.top-g.y)/g.scale;
  let match=-1,area=Infinity;
  state.detections.forEach((d,i)=>{const b=d.boundingBox;if(x>=b.originX&&x<=b.originX+b.width&&y>=b.originY&&y<=b.originY+b.height){const a=b.width*b.height;if(a<area){match=i;area=a}}});
  if(match>=0)selectObject(match);
});
function setMode(mode){
  state.mode=mode;for(const name of ['rgb','depth','blend']){$(`${name}Btn`).classList.toggle('selected',name===mode);$(`${name}Btn`).setAttribute('aria-pressed',String(name===mode))}
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
$('resumeBtn').addEventListener('click',()=>{if(state.sourceType==='photo'){$('fileInput').click();return}state.frozen=false;state.depth=null;state.selected=-1;state.pins=[];$('objectPanel').hidden=true;$('captureBtn').hidden=false;$('resumeBtn').hidden=true;badge('LIVE');setStage('LIVE CAMERA');$('depthState').textContent='DEPTH IDLE';setMode('rgb');requestAnimationFrame(tick)});
for(const mode of ['rgb','depth','blend'])$(`${mode}Btn`).addEventListener('click',()=>setMode(mode));
$('closePanel').addEventListener('click',()=>{state.selected=-1;$('objectPanel').hidden=true;draw()});
$('anchorBtn').addEventListener('click',()=>{const b=state.detections[state.selected]?.boundingBox;if(!b)return;state.pins.push({x:b.originX+b.width/2,y:b.originY+b.height/2});status('Pin attached to this captured frame');draw()});
$('copyBtn').addEventListener('click',async()=>{const label=$('objectName').textContent;try{await navigator.clipboard.writeText(label);status(`Copied “${label}”`)}catch{status('Clipboard unavailable')}});
$('shareBtn').addEventListener('click',async()=>{const label=$('objectName').textContent;try{if(navigator.share)await navigator.share({title:'Spatial Objects scan',text:`I scanned ${label} with Spatial Objects.`});else{await navigator.clipboard.writeText(`Spatial Objects: ${label}`);status('Object label copied')}}catch(error){if(error.name!=='AbortError')status(`Share failed: ${readableError(error)}`)}});
window.addEventListener('resize',draw);
window.addEventListener('pagehide',()=>state.stream?.getTracks().forEach(track=>track.stop()));
draw();
