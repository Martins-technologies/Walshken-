export type Point={x:number;y:number};
export type ScanQuad=[Point,Point,Point,Point];
const clamp=(value:number,min=0,max=1)=>Math.min(max,Math.max(min,value));
export const fullScanFrame=():ScanQuad=>[{x:.02,y:.02},{x:.98,y:.02},{x:.98,y:.98},{x:.02,y:.98}];

export async function loadScanImage(file:File) {
  if(!file.type.startsWith("image/")||file.size>25*1024*1024)throw new Error("Choose a camera photo smaller than 25 MB.");
  const photo=await createImageBitmap(file);
  try{
    const scale=Math.min(1,1800/Math.max(photo.width,photo.height)),canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(photo.width*scale));canvas.height=Math.max(1,Math.round(photo.height*scale));
    canvas.getContext("2d")!.drawImage(photo,0,0,canvas.width,canvas.height);
    return canvas;
  }finally{photo.close();}
}

function area(quad:ScanQuad){
  return quad.reduce((sum,p,i)=>{const q=quad[(i+1)%4];return sum+p.x*q.y-p.y*q.x;},0)/2;
}

export function detectScanFrame(source:HTMLCanvasElement):ScanQuad {
  const preview=document.createElement("canvas"),scale=Math.min(1,300/Math.max(source.width,source.height));
  const w=preview.width=Math.round(source.width*scale),h=preview.height=Math.round(source.height*scale);
  if(w<20||h<20)return fullScanFrame();
  const ctx=preview.getContext("2d",{willReadFrequently:true})!;
  ctx.drawImage(source,0,0,w,h);
  const {data}=ctx.getImageData(0,0,w,h),brightness=new Uint8Array(w*h),hist=new Uint32Array(256);
  for(let i=0;i<brightness.length;i++){
    const pos=i*4,lum=Math.round(.213*data[pos]+.715*data[pos+1]+.072*data[pos+2]);
    brightness[i]=lum;hist[lum]++;
  }
  const quantile=(fraction:number)=>{
    let total=0;
    return hist.findIndex(count=>(total+=count)>=brightness.length*fraction);
  };
  const low=quantile(.35),high=quantile(.83);
  if(high-low<32)return fullScanFrame();
  const threshold=Math.max(118,Math.round(low+(high-low)*.64));
  const points:Point[]=[],step=Math.max(2,Math.round(Math.min(w,h)/100));
  for(let y=step;y<h-step;y+=step){
    for(let x=step;x<w-step;x+=step){
      const pixel=y*w+x;
      if(brightness[pixel]>=threshold&&brightness[pixel-step]>=threshold&&brightness[pixel+step]>=threshold&&brightness[pixel-w*step]>=threshold&&brightness[pixel+w*step]>=threshold)
        points.push({x:x/w,y:y/h});
    }
  }
  if(points.length<20)return fullScanFrame();
  function extreme(score:(p:Point)=>number) {
    return points.reduce((best,p)=>score(p)<score(best)?p:best);
  }
  const result:ScanQuad=[extreme(p=>p.x+p.y),extreme(p=>p.y-p.x),extreme(p=>-p.x-p.y),extreme(p=>p.x-p.y)];
  return plausibleFrame(result)&&area(result)>.2?result:fullScanFrame();
}

export function plausibleFrame(q:ScanQuad){
  return area(q)>.045&&q.every((a,i)=>{
    const b=q[(i+1)%4],c=q[(i+2)%4];
    return (b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x)>.007;
  });
}

export function rotateScan(source:HTMLCanvasElement){
  const canvas=document.createElement("canvas");
  canvas.width=source.height;canvas.height=source.width;
  const ctx=canvas.getContext("2d")!;
  ctx.translate(canvas.width,0);ctx.rotate(Math.PI/2);ctx.drawImage(source,0,0);
  return canvas;
}

export function cropScan(source:HTMLCanvasElement,q:ScanQuad,enhance:boolean){
  if(!plausibleFrame(q))throw new Error("Move the four corners into a valid rectangle around the document.");
  const [a,b,c,d]=q.map(p=>({x:p.x*(source.width-1),y:p.y*(source.height-1)}));
  const distance=(p:Point,r:Point)=>Math.hypot(p.x-r.x,p.y-r.y);
  const canvas=document.createElement("canvas");
  const w=canvas.width=Math.max(2,Math.min(1800,Math.round(Math.max(distance(a,b),distance(d,c)))));
  const h=canvas.height=Math.max(2,Math.min(1800,Math.round(Math.max(distance(b,c),distance(a,d)))));
  const context=canvas.getContext("2d")!,image=context.createImageData(w,h),dst=image.data;
  const pixels=source.getContext("2d")!.getImageData(0,0,source.width,source.height).data;
  // Project the output rectangle into the four selected source corners.
  const dx1=b.x-c.x,dx2=d.x-c.x,dx3=a.x-b.x+c.x-d.x;
  const dy1=b.y-c.y,dy2=d.y-c.y,dy3=a.y-b.y+c.y-d.y,det=dx1*dy2-dx2*dy1;
  const g=(dx3*dy2-dx2*dy3)/det,k=(dx1*dy3-dx3*dy1)/det;
  const ax=b.x-a.x+g*b.x,bx=d.x-a.x+k*d.x,ay=b.y-a.y+g*b.y,by=d.y-a.y+k*d.y;
  for(let y=0;y<h;y++){
    const v=y/(h-1);
    for(let x=0;x<w;x++){
      const u=x/(w-1),divisor=g*u+k*v+1;
      const px=clamp((ax*u+bx*v+a.x)/divisor,0,source.width-1),py=clamp((ay*u+by*v+a.y)/divisor,0,source.height-1);
      const ix=Math.floor(px),iy=Math.floor(py),sx=px-ix,sy=py-iy;
      const p0=(iy*source.width+ix)*4,p1=(iy*source.width+Math.min(ix+1,source.width-1))*4;
      const p2=(Math.min(iy+1,source.height-1)*source.width+ix)*4,p3=(Math.min(iy+1,source.height-1)*source.width+Math.min(ix+1,source.width-1))*4;
      const dest=(y*w+x)*4;
      for(let channel=0;channel<3;channel++){
        const sample=(pixels[p0+channel]*(1-sx)+pixels[p1+channel]*sx)*(1-sy)+(pixels[p2+channel]*(1-sx)+pixels[p3+channel]*sx)*sy;
        dst[dest+channel]=enhance?clamp(128+(sample-128)*1.21+8,0,255):sample;
      }
      dst[dest+3]=255;
    }
  }
  context.putImageData(image,0,0);
  return canvas;
}

export async function exportScan(canvas:HTMLCanvasElement,format:"pdf"|"jpeg") {
  function jpeg(quality:number){return new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error("The photo could not be saved.")),"image/jpeg",quality));}
  let blob=await jpeg(.88);
  if(blob.size>2.9*1024*1024)blob=await jpeg(.70);
  if(format==="jpeg")return new File([blob],"document-scan.jpg",{type:"image/jpeg"});
  const {PDFDocument}=await import("pdf-lib");
  const doc=await PDFDocument.create(),image=await doc.embedJpg(await blob.arrayBuffer());
  const page=doc.addPage([image.width,image.height]);
  page.drawImage(image,{x:0,y:0,width:image.width,height:image.height});
  const bytes=await doc.save();
  return new File([Uint8Array.from(bytes)],"document-scan.pdf",{type:"application/pdf"});
}
