/** 无 Node/DOM 依赖的 SHA-256，用于微信包内关卡摘要验证。 */
const primes=[];for(let n=2;primes.length<64;n++){if(primes.every(p=>n%p))primes.push(n);}
const constants=primes.map(p=>Math.floor((Math.cbrt(p)%1)*0x100000000)>>>0);
const rotate=(x,n)=>(x>>>n)|(x<<(32-n));
export function sha256(input){
 const bytes=input instanceof ArrayBuffer?new Uint8Array(input):new Uint8Array(input.buffer,input.byteOffset,input.byteLength),length=Math.ceil((bytes.length+9)/64)*64,data=new Uint8Array(length);data.set(bytes);data[bytes.length]=128;const view=new DataView(data.buffer);view.setUint32(length-8,Math.floor(bytes.length/0x20000000));view.setUint32(length-4,(bytes.length*8)>>>0);
 const hash=primes.slice(0,8).map(p=>Math.floor((Math.sqrt(p)%1)*0x100000000)>>>0),words=new Uint32Array(64);
 for(let offset=0;offset<length;offset+=64){for(let i=0;i<16;i++)words[i]=view.getUint32(offset+i*4);for(let i=16;i<64;i++){const a=words[i-15],b=words[i-2];words[i]=(words[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+words[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0;}
 let [a,b,c,d,e,f,g,h]=hash;for(let i=0;i<64;i++){const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+constants[i]+words[i])>>>0,t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}[a,b,c,d,e,f,g,h].forEach((value,i)=>{hash[i]=(hash[i]+value)>>>0;});
 }return hash.map(value=>value.toString(16).padStart(8,'0')).join('');
}
