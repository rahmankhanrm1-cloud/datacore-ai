import assert from "node:assert/strict";
import {generateCosmosVideo,checkSignedVideo,videoUrl} from "../cosmos-video.js";

const user={id:"11111111-1111-4111-a111-111111111111"};
const env={ADMIN_KEY:"test-signing-secret-that-is-long-and-safe",FILES:{
  put:async (name,bytes)=>{env.savedName=name;env.savedBytes=bytes},
  get:async()=>null
}};
const req=new Request("https://test.example.com/api/ai",{method:"POST"});
await assert.rejects(
  generateCosmosVideo(req,env,user,{prompt:"A flying plane",duration:5}),
  error=>error.code==="COSMOS_NOT_CONFIGURED"
);
env.NVIDIA_COSMOS_API_KEY="example-test-key";
await assert.rejects(
  generateCosmosVideo(req,env,user,{prompt:"A flying plane",duration:30}),
  error=>error.code==="VIDEO_DURATION_UNSUPPORTED"
);
const mp4=new Uint8Array(32);
mp4.set([0,0,0,32,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109]);
let sent,auth;
globalThis.fetch=async (url,opts)=>{
  assert.equal(url,"https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano");
  auth=opts.headers.Authorization;
  sent=JSON.parse(opts.body);
  return new Response(JSON.stringify({b64_video:Buffer.from(mp4).toString("base64")}),
    {status:200,headers:{"Content-Type":"application/json"}});
};
const result=await generateCosmosVideo(req,env,user,{prompt:"Sunset cinematic ocean",duration:10});
assert.equal(auth,"Bearer example-test-key");
assert.equal(sent.model_mode,"text2video");
assert.equal(sent.num_frames,241);
assert.equal(sent.fps,24);
assert.equal(result.duration,10);
assert.equal(env.savedBytes.length,mp4.length);
assert.match(env.savedName,/^generated\/11111111-1111-4111-a111-111111111111\/[a-f0-9-]+\.mp4$/);
assert.equal(await checkSignedVideo(new Request(result.url),env,user.id,result.videoId),true);
assert.equal(await checkSignedVideo(new Request(result.url.replace("sig=","sig=bad")),env,user.id,result.videoId),false);
const photo=new File([new Uint8Array([255,216,255,217])],"sample.jpg",{type:"image/jpeg"});
const photoResult=await generateCosmosVideo(req,env,user,{prompt:"Animate the photo",file:photo,duration:5});
assert.equal(sent.model_mode,"image2video");
assert.ok(sent.input_reference.startsWith("data:image/jpeg;base64,"));
assert.equal(sent.num_frames,121);
assert.ok(photoResult.url.startsWith("https://test.example.com/api/generated-video/"));
globalThis.fetch=async (_url,opts)=>{assert.equal(opts.redirect,"manual");return new Response("not found",{status:404});};
await assert.rejects(generateCosmosVideo(req,env,user,{prompt:"A paper boat",duration:5}),error=>error.code==="COSMOS_ENDPOINT_UNAVAILABLE");
console.log("Cosmos video API mock, image payload, MP4 validation and HMAC link verification: PASS");
