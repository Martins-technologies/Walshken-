import http from 'node:http';
import net from 'node:net';
import {createHash,timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';

const token=process.env.CLAMAV_API_TOKEN??'';
if(token.length<32)throw Error('Set CLAMAV_API_TOKEN to a private token of at least 32 characters.');
const maxBytes=3*1024*1024;
const signatureHours=Number(process.env.CLAMAV_MAX_SIGNATURE_AGE_HOURS??72);
if(!Number.isFinite(signatureHours)||signatureHours<1||signatureHours>168)throw Error('Use a signature age limit between 1 and 168 hours.');
let active=0;
function authorized(header){
 const supplied=Buffer.from(header??''),expected=Buffer.from('Bearer '+token);
 return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}
async function clamd(command,bytes){
 const socket=process.env.CLAMAV_SOCKET?net.createConnection(process.env.CLAMAV_SOCKET)
  :net.createConnection({host:process.env.CLAMAV_HOST??'127.0.0.1',port:Number(process.env.CLAMAV_PORT??3310)});
 socket.setTimeout(15_000,()=>socket.destroy(Error('Scanner timeout')));
 const reply=new Promise((resolve,reject)=>{
  let response=Buffer.alloc(0);
  socket.on('error',reject);
  socket.on('end',()=>{if(!response.includes(0))reject(Error('Incomplete scanner reply'));});
  socket.on('data',data=>{
   response=Buffer.concat([response,data]);
   if(response.length>4096){reject(Error('Oversized scanner reply'));socket.destroy();return;}
   if(response.includes(0)){resolve(response.subarray(0,response.indexOf(0)).toString());socket.end();}
  });
 });
 void reply.catch(()=>{});
 try{
  await once(socket,'connect');
  socket.write('z'+command+'\0');
  if(bytes){
   for(let offset=0;offset<bytes.length;offset+=65536){
    const chunk=bytes.subarray(offset,offset+65536),length=Buffer.alloc(4);length.writeUInt32BE(chunk.length);
    if(!socket.write(Buffer.concat([length,chunk])))await once(socket,'drain');
   }
   socket.write(Buffer.alloc(4));
  }
  return await reply;
 }finally{socket.destroy();}
}
async function version(){
 const response=await clamd('VERSION');
 const [engine,,updated]=String(response).split('/');
 const stamp=Date.parse(updated??'');
 if(!engine.startsWith('ClamAV ')||!Number.isFinite(stamp)||Date.now()-stamp>signatureHours*3600000||stamp>Date.now()+3600000)throw Error('Fresh scanner signatures are required.');
 return engine;
}
function send(res,status,body){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({protocol:'walshken-scan-v1',...body}));}
const server=http.createServer(async(req,res)=>{
 if(!authorized(req.headers.authorization)){send(res,401,{error:'Authentication required'});return;}
 if(req.url!=='/scan'||!['GET','POST'].includes(req.method??'')){send(res,404,{error:'Unknown scanner operation'});return;}
 if(active>=8){send(res,503,{error:'Scanner busy'});return;}
 active++;
 try{
  const engine=await version();
  if(req.method==='GET'){send(res,200,{ready:true,engine});return;}
  if(req.headers['content-type']!=='application/octet-stream'||Number(req.headers['content-length']??0)>maxBytes){send(res,400,{error:'Invalid upload'});return;}
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>maxBytes){send(res,413,{error:'Upload too large'});return;}chunks.push(chunk);}
  const bytes=Buffer.concat(chunks),sha256=createHash('sha256').update(bytes).digest('hex');
  if(!size||req.headers['x-content-sha256']!==sha256){send(res,400,{error:'File digest mismatch'});return;}
  const verdict=await clamd('INSTREAM',bytes);
  if(verdict==='stream: OK')send(res,200,{sha256,verdict:'clean',engine});
  else if(verdict.endsWith(' FOUND'))send(res,200,{sha256,verdict:'infected',engine});
  else send(res,503,{sha256,verdict:'failed'});
 }catch{if(!res.headersSent)send(res,503,{ready:false,verdict:'failed'});}
 finally{active--;}
});
server.requestTimeout=25000;
server.headersTimeout=10000;
server.listen(Number(process.env.PORT??8080),process.env.BIND_ADDRESS??'127.0.0.1');
