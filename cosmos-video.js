// NibrasGPT Cosmos3 Nano integration, guarded by a distinct server-side key.
// No secret is returned to client, embedded in APK, or stored in Generated media.
const API="https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano";
const encoder=new TextEncoder();
const acceptedImages=new Set(["image/jpeg","image/png","image/webp"]);
const base64url=bytes=>{
 let s="";for(const n of bytes)s+=String.fromCharCode(n);
 return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
};
function videoError(message,code="VIDEO_PROVIDER_UNAVAILABLE"){const e=new Error(message);e.code=code;return e;}
async function sign(env,message){
 const secret=String(env.ADMIN_KEY||"");
 if(secret.length<12)throw videoError("Signing configuration is unavailable.", "VIDEO_SIGNING_UNAVAILABLE");
 const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 return base64url(new Uint8Array(await crypto.subtle.sign("HMAC",key,encoder.encode(message))));
}
export async function videoUrl(request,env,userId,videoId,ttl=3600*6){
 const expires=Math.floor(Date.now()/1000)+ttl;
 const signature=await sign(env,userId+"/"+videoId+"/"+expires);
 const base=new URL(request.url).origin;
 return base+"/api/generated-video/"+encodeURIComponent(userId)+"/"+encodeURIComponent(videoId)+"?exp="+expires+"&sig="+signature;
}
export async function checkSignedVideo(request,env,userId,videoId){
 if(!/^[a-f0-9-]{36}$/i.test(userId)||!/^[a-f0-9-]{36}$/i.test(videoId))return false;
 const url=new URL(request.url),exp=Number(url.searchParams.get("exp"));
 const sig=url.searchParams.get("sig")||"";
 if(!Number.isInteger(exp)||exp<Math.floor(Date.now()/1000)||exp>Math.floor(Date.now()/1000)+86400)return false;
 const expected=await sign(env,userId+"/"+videoId+"/"+exp);
 if(expected.length!==sig.length)return false;
 let mismatch=0;for(let i=0;i<sig.length;i++)mismatch|=expected.charCodeAt(i)^sig.charCodeAt(i);
 return mismatch===0;
}
function decodeMp4(b64){
 const raw=String(b64||"").replace(/^data:video\/mp4;base64,/i,"").replace(/\s/g,"");
 if(raw.length<40||raw.length>60000000)throw videoError("The provider did not return a valid-size MP4.", "VIDEO_INVALID_RESPONSE");
 let decoded;
 try{decoded=atob(raw);}catch{throw videoError("The provider sent invalid video data.", "VIDEO_INVALID_RESPONSE");}
 if(decoded.length<24 || decoded.slice(4,8)!=="ftyp")throw videoError("The response is not an MP4 file.", "VIDEO_INVALID_RESPONSE");
 const bytes=new Uint8Array(decoded.length);
 for(let i=0;i<decoded.length;i++)bytes[i]=decoded.charCodeAt(i);
 return bytes;
}
export async function generateCosmosVideo(request,env,user,{prompt,file=null,duration=5}){
 const key=String(env.NVIDIA_COSMOS_API_KEY||"").trim();
 if(!key)throw videoError("NVIDIA Cosmos Video is not connected yet. The owner must add NVIDIA_COSMOS_API_KEY as a Cloudflare secret.", "COSMOS_NOT_CONFIGURED");
 const seconds=Number(duration);
 if(![5,10].includes(seconds))throw videoError("The current Cosmos integration supports 5 or 10 seconds. A verified long-video provider is needed for 30 seconds.", "VIDEO_DURATION_UNSUPPORTED");
 const body={model_mode:file?"image2video":"text2video",prompt:String(prompt||"").trim().slice(0,4000),
   seed:Math.floor(Math.random()*1000000),num_inference_steps:35,guidance_scale:6,
   flow_shift:10,fps:24,resolution:"480_16_9",num_frames:seconds===10?241:121};
 if(!body.prompt)body.prompt=file?"Natural cinematic animation with smooth coherent motion.":"";
 if(!body.prompt)throw videoError("Enter a prompt for Text to Video.", "PROMPT_REQUIRED");
 if(file){
  const mime=String(file.type||"").toLowerCase();
  if(!acceptedImages.has(mime)||file.size>8*1024*1024)throw videoError("Photo to Video supports JPG, PNG, WebP up to 8 MB.", "VIDEO_IMAGE_UNSUPPORTED");
  const binary=new Uint8Array(await file.arrayBuffer());
  if(!binary.length)throw videoError("The uploaded image is empty.","VIDEO_IMAGE_UNSUPPORTED");
  let input64="";for(let i=0;i<binary.length;i+=32768)input64+=String.fromCharCode(...binary.subarray(i,i+32768));
  body.input_reference="data:"+mime+";base64,"+btoa(input64);
 }
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),110000);
 let response;
 try{response=await fetch(API,{method:"POST",
  headers:{Authorization:"Bearer "+key,"Content-Type":"application/json",Accept:"application/json"},
  body:JSON.stringify(body),signal:controller.signal,redirect:"manual"});
 }catch{
  throw videoError("NVIDIA Cosmos Video is unavailable or processing timed out. No video credits were deducted.","VIDEO_PROVIDER_UNAVAILABLE");
 }finally{clearTimeout(timeout);}
 if(response.status===404)throw videoError("NVIDIA Cosmos hosted endpoint returned HTTP 404. Its public preview API is unavailable for this request; your saved key has not been changed.","COSMOS_ENDPOINT_UNAVAILABLE");
 if(response.status>=300&&response.status<400)throw videoError("NVIDIA Cosmos returned an unexpected redirect. No credentials were forwarded.","VIDEO_PROVIDER_UNAVAILABLE");
 if(response.status===401||response.status===403)throw videoError("NVIDIA Cosmos key is invalid, revoked or lacks permission.","COSMOS_AUTH_FAILED");
 if(response.status===429)throw videoError("NVIDIA Cosmos API quota has been reached. Retry after provider quota resets.","COSMOS_QUOTA_REACHED");
 if(response.status===402)throw videoError("NVIDIA Cosmos provider requires credits. No paid service was activated.","COSMOS_BILLING_REQUIRED");
 if(!response.ok)throw videoError("NVIDIA Cosmos could not generate the video (HTTP "+response.status+").","VIDEO_PROVIDER_UNAVAILABLE");
 const result=await response.json().catch(()=>null);
 if(!result?.b64_video)throw videoError("NVIDIA returned no MP4 video. Check model availability and API contract.","VIDEO_INVALID_RESPONSE");
 const bytes=decodeMp4(result.b64_video);
 const videoId=crypto.randomUUID(),objectKey="generated/"+user.id+"/"+videoId+".mp4";
 await env.FILES.put(objectKey,bytes,{httpMetadata:{contentType:"video/mp4"},customMetadata:{type:"cosmos-video"}});
 return {url:await videoUrl(request,env,user.id,videoId),bytes:bytes.length,duration:seconds,videoId};
}
