// node test/lj92.js — encodes a synthetic Bayer DNG with lossless JPEG (predictors 1-7) and checks the decoder.
const A=require('./load');
function encodeLJ92(samples, W, H, C, bits, pred){
  // compute diffs and ssss, build huffman table with simple code lengths (canonical, all symbols 0..16)
  const rowLen=W*C, diffs=new Int32Array(W*H*C);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++)for(let c=0;c<C;c++){
    const i=y*rowLen+x*C+c; let p;
    if(y===0) p = x===0 ? 1<<(bits-1) : samples[i-C];
    else if(x===0) p=samples[i-rowLen];
    else { const ra=samples[i-C],rb=samples[i-rowLen],rc=samples[i-rowLen-C];
      p = pred===1?ra:pred===2?rb:pred===3?rc:pred===4?ra+rb-rc:pred===5?ra+((rb-rc)>>1):pred===6?rb+((ra-rc)>>1):(ra+rb)>>1; }
    let d=(samples[i]-p)&0xffff; if(d>=32768) d-=65536; diffs[i]=d;}
  // fixed lengths: symbols 0..16 with lengths: use 5 bits for all (17 symbols -> need 5 bits; canonical: counts[4]=17? max 2^5=32 ok but all-ones code forbidden; 17<31 fine)
  const counts=new Uint8Array(16);counts[4]=17;const symbols=[...Array(17).keys()];
  const out=[];const put16=v=>{out.push(v>>8,v&255);};
  put16(0xffd8);
  put16(0xffc3);put16(8+3*C);out.push(bits);put16(H);put16(W);out.push(C);for(let c=0;c<C;c++)out.push(c+1,0x11,0);
  put16(0xffc4);put16(2+17+17);out.push(0);for(let i=0;i<16;i++)out.push(counts[i]);out.push(...symbols);
  put16(0xffda);put16(6+2*C);out.push(C);for(let c=0;c<C;c++)out.push(c+1,0);out.push(pred,0,0);
  let acc=0,n=0;const bitsOut=(v,l)=>{for(let k=l-1;k>=0;k--){acc=(acc<<1)|((v>>k)&1);n++;if(n===8){out.push(acc);if(acc===0xff)out.push(0);acc=0;n=0;}}};
  for(let i=0;i<diffs.length;i++){const d=diffs[i];let s=0,a=Math.abs(d);while(a){s++;a>>=1;} if(d===-32768)s=16;
    bitsOut(s,5); if(s&&s<16){const v=d<0?d+(1<<s)-1:d;bitsOut(v,s);} }
  if(n){bitsOut(0x7f,8-n);} put16(0xffd9); return Uint8Array.from(out);
}
(async()=>{
 const src=A.makeDemoStack(1,320,200,3)[0].data;const buf=src.buffer.slice(src.byteOffset,src.byteOffset+src.length);
 const r=new A.TiffReader(buf);const ifd=r.ifds[0];const W=r.value(ifd,A.TAG.ImageWidth),H=r.value(ifd,A.TAG.ImageLength);
 const off=r.value(ifd,A.TAG.StripOffsets);const mosaic=new Uint16Array(buf.slice(off,off+W*H*2));
 const entries=[];for(const [tag,e] of ifd.entries){ if([273,279,259,278].includes(tag))continue; entries.push({tag,type:e.type,values:r.values(ifd,tag)});}
 const ref=await A.decodeDNG(buf,{});
 for(let pred=1;pred<=7;pred++){
  const rps=64,strips=[];
  for(let y=0;y<H;y+=rps){const rows=Math.min(rps,H-y);strips.push(encodeLJ92(mosaic.subarray(y*W,(y+rows)*W),W/2,rows,2,14,pred));}
  const dng=A.writeTiff(entries.concat([{tag:259,type:3,values:[7]},{tag:278,type:4,values:[rps]}]),strips);
  const d=await A.decodeDNG(dng.buffer.slice(0),{});
  for(let i=0;i<d.data.length;i++) if(d.data[i]!==ref.data[i]) throw new Error('predictor '+pred+' mismatch at '+i);
 }
 console.log('ok lossless JPEG predictors 1-7');
})().catch(e=>{console.error(e);process.exit(1)});
