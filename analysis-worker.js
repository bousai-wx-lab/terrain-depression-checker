import { decodeElevationRgb, lonLatToWorldPixel, worldPixelToLonLat, metersPerPixel } from './terrain.js';
import { chooseAreaPlan, allocatePrefix, finishPrefix, calculateAreaRow, queryDisk, diskRows,
  gridPositions, positionInsideAnalysis } from './area.js';

const RELEASE = '20260905-6';
const GSI = 'https://cyberjapandata.gsi.go.jp/xyz';
const SOURCES = [['dem1a_png',17],['dem5a_png',15],['dem5b_png',15],['dem5c_png',15],['dem_png',14]];
const cache = new Map();
let cacheBytes = 0, active = 0, last = null, indexPromise = null, prepared = null;
let pending = null, running = false;
const pause = () => new Promise(resolve => setTimeout(resolve,0));

function cached(key, factory) {
  if (cache.has(key)) {
    const entry = cache.get(key); cache.delete(key); cache.set(key,entry); return entry.promise;
  }
  const entry = {bytes:0,promise:null};
  entry.promise = factory().then(value => {
    entry.bytes = value?.bytes ?? 0; cacheBytes += entry.bytes;
    for (const [oldKey,old] of cache) {
      if (cacheBytes <= 48*1024*1024) break;
      if (oldKey === key || !old.bytes) continue;
      cacheBytes -= old.bytes; cache.delete(oldKey);
    }
    return value;
  }).catch(error => { if(cache.get(key)===entry)cache.delete(key); throw error; });
  cache.set(key,entry); return entry.promise;
}

async function index() {
  if (!indexPromise) indexPromise = (async () => {
    const response = await fetch(`./data/area-index.json?v=${RELEASE}`, {signal:AbortSignal.timeout(20000)});
    if (!response.ok) throw Error('集計データの一覧を取得できませんでした');
    const value = await response.json();
    if (value.version !== 1 || value.tile_size !== 128 || !value.global_tiles) throw Error('集計データの版が一致しません');
    return value;
  })().catch(error => {indexPromise=null;throw error;});
  return indexPromise;
}

async function summary(kind,z,x,y) {
  const manifest = await index(), key = `${z}/${x}/${y}`;
  const record = manifest[kind === 'area' ? 'tiles' : 'global_tiles'][key];
  if (!record) return null; // Enumerated empty tile, not an HTTP failure.
  return cached(`${kind}/${key}`,async () => {
    const response = await fetch(`./data/${kind}-v1/${key}.json.gz?h=${record.sha256.slice(0,16)}`, {signal:AbortSignal.timeout(20000)});
    if (!response.ok) throw Error('集計データを取得できませんでした');
    const bytes = await response.arrayBuffer();
    if(bytes.byteLength!==record.bytes)throw Error('集計データのサイズが一致しません');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
    if(hash!==record.sha256)throw Error('集計データを照合できませんでした');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const data = await new Response(stream).json();
    if(data.v!==1||data.z!==z||data.x!==x||data.y!==y||data.n!==128||data.e?.length!==16384||data.a?.length!==16384)throw Error('集計データの形式が一致しません');
    const elevations = new Float32Array(16384), areas = new Float32Array(16384);
    for(let i=0;i<16384;i++) {
      if(!Number.isInteger(data.e[i])||!Number.isInteger(data.a[i])||data.a[i]<0||data.a[i]>1e9)throw Error('集計データの数値が不正です');
      elevations[i]=data.e[i]*.001;areas[i]=data.a[i]/1e9;
    }
    return {elevations,areas,bytes:elevations.byteLength+areas.byteLength};
  });
}

async function providerTile(source,z,x,y) {
  return cached(`${source}/${z}/${x}/${y}`,async () => {
    const response = await fetch(`${GSI}/${source}/${z}/${x}/${y}.png`,{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(20000)});
    if(response.status===404)return {values:null,bytes:32};
    if(!response.ok)throw Error('標高データを取得できませんでした');
    const blob=await response.blob();
    if(blob.type&&blob.type!=='image/png')throw Error('標高データの形式が違います');
    const bitmap=await createImageBitmap(blob),canvas=new OffscreenCanvas(256,256);
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0);bitmap.close();
    const pixels=context.getImageData(0,0,256,256).data,values=new Float32Array(65536);values.fill(NaN);
    for(let i=0;i<65536;i++)if(pixels[i*4+3])values[i]=decodeElevationRgb(pixels[i*4],pixels[i*4+1],pixels[i*4+2])??NaN;
    return {values,bytes:values.byteLength};
  });
}

async function globalAt(worldX,worldY,zoom) {
  const z=Math.min(8,zoom),scale=2**(z-zoom),x=worldX*scale,y=worldY*scale;
  const tile=await summary('global',z,Math.floor(x/128),Math.floor(y/128));
  if(!tile)return NaN;
  const i=(Math.floor(y)%128+128)%128*128+(Math.floor(x)%128+128)%128;
  return tile.areas[i]>0?tile.elevations[i]:NaN;
}

async function detailTile(z,x,y) {
  return cached(`detail/${z}/${x}/${y}`,async () => {
    const values=new Float32Array(65536),sourceZooms=new Uint8Array(65536);values.fill(NaN);
    let valid=0;
    const sources=z<=12?[SOURCES[4]]:SOURCES;
    for(const [name,maxZoom] of sources) {
      const sourceZoom=Math.min(z,maxZoom),factor=2**(z-sourceZoom);
      const tx=Math.floor(x/factor),ty=Math.floor(y/factor);
      const source=await providerTile(name,sourceZoom,tx,ty);
      if(!source.values)continue;
      const offsetX=(x*256/factor)%256,offsetY=(y*256/factor)%256;
      for(let row=0;row<256;row++)for(let col=0;col<256;col++) {
        const i=row*256+col;if(Number.isFinite(values[i]))continue;
        const v=source.values[Math.floor(offsetY+row/factor)*256+Math.floor(offsetX+col/factor)];
        if(Number.isFinite(v)){values[i]=v;sourceZooms[i]=sourceZoom;valid++;}
      }
      if(valid===65536)break;
    }
    // The supplemental global summaries explicitly exclude every native global
    // cell in which Japanese DEM land is present, including shoreline fringes.
    if(valid<65536) {
      const gz=Math.min(8,z),factor=2**(z-gz),gx=x*256/factor,gy=y*256/factor;
      const tiles=new Map();
      for(let ty=Math.floor(gy/128);ty<=Math.floor((gy+256/factor-1e-8)/128);ty++)for(let tx=Math.floor(gx/128);tx<=Math.floor((gx+256/factor-1e-8)/128);tx++)tiles.set(`${tx}/${ty}`,await summary('global',gz,tx,ty));
      for(let row=0;row<256;row++)for(let col=0;col<256;col++) {
        const i=row*256+col;if(Number.isFinite(values[i]))continue;
        const px=Math.floor(gx+col/factor),py=Math.floor(gy+row/factor),tile=tiles.get(`${Math.floor(px/128)}/${Math.floor(py/128)}`);
        const j=((py%128+128)%128)*128+(px%128+128)%128;
        if(tile&&tile.areas[j]>0){values[i]=tile.elevations[j];sourceZooms[i]=gz;}
      }
    }
    return {values,sourceZooms,bytes:values.byteLength+sourceZooms.byteLength};
  });
}

async function pool(tasks,limit,id) {
  let next=0;
  await Promise.all(Array.from({length:Math.min(limit,tasks.length)},async()=>{
    while(next<tasks.length){if(id!==active)return;await tasks[next++]();}
  }));
}

async function storedPrefix(plan,id) {
  if (prepared && prepared.stored && prepared.zoom === plan.zoom && prepared.x0 <= plan.x0 && prepared.y0 <= plan.y0 &&
      prepared.x0 + prepared.width >= plan.x0 + plan.width && prepared.y0 + prepared.height >= plan.y0 + plan.height) return prepared;
  prepared = null;
  const p=allocatePrefix(plan),tasks=[];
  for(const kind of ['area','global']) {
    const z=kind==='area'?plan.zoom:Math.min(8,plan.zoom),factor=2**(plan.zoom-z);
    const xMin=Math.floor(plan.x0/factor/128),xMax=Math.floor((plan.x0+plan.width-1)/factor/128);
    const yMin=Math.floor(plan.y0/factor/128),yMax=Math.floor((plan.y0+plan.height-1)/factor/128);
    for(let ty=yMin;ty<=yMax;ty++)for(let tx=xMin;tx<=xMax;tx++)tasks.push(async()=>{
      const tile=await summary(kind,z,tx,ty);if(!tile||id!==active)return;
      const left=tx*128*factor-plan.x0,top=ty*128*factor-plan.y0;
      for(let y=Math.max(0,top);y<Math.min(plan.height,top+128*factor);y++) {
        const sy=Math.floor((y-top)/factor),offset=y*p.stride;
        for(let x=Math.max(0,left);x<Math.min(plan.width,left+128*factor);x++) {
          const i=sy*128+Math.floor((x-left)/factor),area=tile.areas[i];
          if(area>0){p.sums[offset+x+1]+=tile.elevations[i]*area;p.areas[offset+x+1]+=area;}
        }
      }
    });
  }
  await pool(tasks,24,id);if(id!==active)return null;prepared=finishPrefix(p);return prepared;
}

async function livePrefix(plan,id) {
  prepared = null;
  const p=allocatePrefix(plan),tasks=[];
  for(let y=0;y<plan.height;y+=256)for(let x=0;x<plan.width;x+=256)tasks.push(async()=>{
    const tile=await detailTile(plan.zoom,(plan.x0+x)/256,(plan.y0+y)/256);
    if(id!==active)return;
    for(let row=0;row<256;row++)for(let col=0;col<256;col++) {
      const v=tile.values[row*256+col],i=(y+row)*p.stride+x+col+1;
      if(Number.isFinite(v)){p.sums[i]=v;p.areas[i]=1;}
    }
  });
  await pool(tasks,6,id);if(id!==active)return null;return finishPrefix(p);
}

async function details(view,id) {
  const zoom=Math.min(15,view.zoom),center=lonLatToWorldPixel(view.longitude,view.latitude,zoom),scale=2**(zoom-view.zoom);
  const xMin=Math.floor((center.x-view.width/2*scale)/256),xMax=Math.floor((center.x+view.width/2*scale)/256);
  const yMin=Math.floor((center.y-view.height/2*scale)/256),yMax=Math.floor((center.y+view.height/2*scale)/256);
  const tiles=new Map(),tasks=[];
  for(let x=xMin;x<=xMax;x++)for(let y=yMin;y<=yMax;y++)tasks.push(async()=>{tiles.set(`${x}/${y}`,await detailTile(zoom,x,y));});
  await pool(tasks,6,id);return {zoom,tiles};
}

function detailValue(detail,wx,wy,viewZoom) {
  const scale=2**(detail.zoom-viewZoom),x=wx*scale,y=wy*scale;
  const tile=detail.tiles.get(`${Math.floor(x/256)}/${Math.floor(y/256)}`);
  const i=((Math.floor(y)%256+256)%256)*256+(Math.floor(x)%256+256)%256;
  return tile?{value:tile.values[i],zoom:tile.sourceZooms[i]}:{value:NaN,zoom:0};
}

async function analyze(view,id) {
  active=id;last=null;const started=performance.now(),plan=chooseAreaPlan(view);
  if(!plan.usable){postMessage({type:'unavailable',id,message:'この倍率では半径に対して標高データが粗すぎます。地図を拡大してください'});return;}
  postMessage({type:'progress',id,message:'円内の陸地データを読み込み中'});
  const [prefix,detail]=await Promise.all([plan.stored?storedPrefix(plan,id):livePrefix(plan,id),details(view,id)]);
  if(id!==active||!prefix)return;
  const fetched=performance.now();postMessage({type:'progress',id,message:'円内の陸地平均を計算中'});
  const step=Math.max(view.width<=520?5:6,Math.ceil(2**(view.zoom-detail.zoom)));
  const positions=gridPositions(view,step),length=positions.columns*positions.rows;
  const elevations=new Float32Array(length),surroundings=new Float32Array(length),depths=new Float32Array(length),landFractions=new Float32Array(length),statuses=new Uint8Array(length);
  elevations.fill(NaN);surroundings.fill(NaN);depths.fill(NaN);
  const ratio=2**(plan.zoom-view.zoom),xs=Float64Array.from(positions.xs,x=>x*ratio);
  let validCount=0;
  for(let row=0;row<positions.rows;row++) {
    const averages=calculateAreaRow(prefix,xs,positions.ys[row]*ratio,view.radius);
    for(let col=0;col<positions.columns;col++) {
      const i=row*positions.columns+col,pos=worldPixelToLonLat(positions.xs[col],positions.ys[row],view.zoom);
      if(!positionInsideAnalysis(pos.longitude,pos.latitude)){statuses[i]=2;continue;}
      const center=detailValue(detail,positions.xs[col],positions.ys[row],view.zoom);
      if(!Number.isFinite(center.value))continue;
      elevations[i]=center.value;surroundings[i]=averages.means[col];landFractions[i]=averages.fractions[col];
      if(!Number.isFinite(averages.means[col])||view.radius/metersPerPixel(pos.latitude,center.zoom)<2){statuses[i]=3;continue;}
      depths[i]=averages.means[col]-center.value;statuses[i]=1;validCount++;
    }
    if(row%8===0){await pause();if(id!==active)return;}
  }
  last={id,view,plan,prefix};
  const elapsed=performance.now()-started;
  postMessage({type:'result',id,step,columns:positions.columns,rows:positions.rows,elevations,surroundings,depths,landFractions,statuses,validCount,
    sourceResolution:plan.sourceResolution,detailResolution:metersPerPixel(view.latitude,detail.zoom),analysisZoom:plan.zoom,
    elapsedMs:elapsed,fetchMs:fetched-started,calculationMs:performance.now()-fetched,
    prefixMiB:(prefix.sums.byteLength+prefix.areas.byteLength)/1048576,stored:plan.stored},
    [elevations.buffer,surroundings.buffer,depths.buffer,landFractions.buffer,statuses.buffer]);
}

async function point(message) {
  const context=last;if(!context||message.analysisId!==context.id)return;
  const {position,pointId}=message;
  if(!positionInsideAnalysis(position.longitude,position.latitude)){postMessage({type:'point',pointId,analysisId:context.id,value:null});return;}
  const world=lonLatToWorldPixel(position.longitude,position.latitude,context.plan.zoom);
  const average=queryDisk(context.prefix,world.x,diskRows(context.prefix,world.y,context.view.radius));
  const fine=lonLatToWorldPixel(position.longitude,position.latitude,17);
  const tile=await detailTile(17,Math.floor(fine.x/256),Math.floor(fine.y/256));
  if(context!==last||context.id!==active)return;
  const i=(Math.floor(fine.y)%256)*256+Math.floor(fine.x)%256,elevation=tile.values[i],sourceZoom=tile.sourceZooms[i];
  const valid=average&&Number.isFinite(elevation)&&context.view.radius/metersPerPixel(position.latitude,sourceZoom)>=2;
  postMessage({type:'point',pointId,analysisId:context.id,value:valid?{elevation,surrounding:average.mean,depth:average.mean-elevation,
    elevationDifference:elevation-average.mean,landFraction:average.landFraction,sourceResolution:metersPerPixel(position.latitude,sourceZoom)}:null});
}

async function drain() {
  if(running)return;
  running=true;
  try {
    while(pending) {
      const message=pending;pending=null;
      try {await analyze(message.view,message.id);}
      catch {
        if(message.id===active){last=null;postMessage({type:'error',id:message.id,message:'標高データを取得できませんでした。再試行するか、通信状態を確認してください'});}
      }
    }
  } finally {running=false;}
}

self.onmessage=event=>{
  const message=event.data;
  if(message.type==='cancel'){active=message.id;last=null;pending=null;return;}
  if(message.type==='analyze'){active=message.id;last=null;pending=message;void drain();return;}
  const job=message.type==='point'?point(message):Promise.resolve();
  job.catch(()=>{
    if(message.type==='point')postMessage({type:'point',pointId:message.pointId,analysisId:message.analysisId,value:null,error:true});
  });
};
