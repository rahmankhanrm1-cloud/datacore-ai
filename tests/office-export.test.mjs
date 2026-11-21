import {buildOfficeDocument} from "../office-export.js";
import {writeFileSync,mkdirSync} from "node:fs";
import assert from "node:assert/strict";

const out = "/tmp/nibras-office-exports";
mkdirSync(out,{recursive:true});
const documents=[
  {format:"docx",title:"NibrasGPT Report",text:"Introduction\nThis is an authentic Word document.\nதமிழ் text is preserved"},
  {format:"xlsx",title:"NibrasGPT Sheet",text:"Item,Quantity,Price\nLaptop,2,175\nTotal,=SUM(B2:B2),350"},
  {format:"pptx",title:"NibrasGPT Presentation",text:Array.from({length:26},(_,i)=>"Point "+(i+1)+" for the slide deck").join("\n")},
  {format:"pdf",title:"NibrasGPT PDF",text:Array.from({length:100},(_,i)=>"Line "+(i+1)+" of generated PDF").join("\n")}
];
for(const x of documents){
  const result=buildOfficeDocument(x);
  assert.ok(result.bytes instanceof Uint8Array);
  assert.ok(result.bytes.length>100);
  assert.equal(result.filename.endsWith("."+x.format),true);
  if(x.format==="pdf") assert.equal(new TextDecoder().decode(result.bytes.slice(0,8)),"%PDF-1.4");
  else assert.equal(new TextDecoder().decode(result.bytes.slice(0,2)),"PK");
  writeFileSync(out+"/generated."+x.format,result.bytes);
  console.log(x.format+": "+result.bytes.length+" bytes");
}
assert.throws(()=>buildOfficeDocument({format:"pdf",text:"தமிழ்",title:"Tamil"}),/multilingual/i);
assert.throws(()=>buildOfficeDocument({format:"xlsx",text:"",title:"Empty"}),/content/i);
console.log("Office creation and validation: PASS");
