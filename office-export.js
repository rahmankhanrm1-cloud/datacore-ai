// NibrasGPT Office export engine: native OOXML ZIP (uncompressed) + PDF 1.4.
// No third-party runtimes, shell commands, remote calls or API credentials.
const encoder = new TextEncoder();
const utf8 = value => encoder.encode(String(value ?? ""));
const xml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[ch]));
const clip = (value,max) => String(value ?? "").slice(0,max);
function concat(parts){
  const size=parts.reduce((sum,x)=>sum+x.length,0),result=new Uint8Array(size);
  let offset=0;
  for(const part of parts){result.set(part,offset);offset+=part.length;}
  return result;
}
const crcTable=Array.from({length:256},(_,i)=>{
  let c=i;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);
  return c>>>0;
});
function crc32(bytes){
  let v=0xFFFFFFFF;
  for(const b of bytes)v=crcTable[(v^b)&255]^(v>>>8);
  return (v^0xFFFFFFFF)>>>0;
}
function zip(files){
  const locals=[],centers=[];let offset=0;
  for(const [name,data] of files){
    const filename=utf8(name),content=typeof data==="string"?utf8(data):data;
    const crc=crc32(content);
    const local=new Uint8Array(30),lv=new DataView(local.buffer);
    lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);
    lv.setUint16(6,0x0800,true);lv.setUint16(8,0,true);
    lv.setUint32(14,crc,true);lv.setUint32(18,content.length,true);lv.setUint32(22,content.length,true);
    lv.setUint16(26,filename.length,true);
    locals.push(local,filename,content);
    const central=new Uint8Array(46),cv=new DataView(central.buffer);
    cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);
    cv.setUint16(8,0x0800,true);cv.setUint32(16,crc,true);
    cv.setUint32(20,content.length,true);cv.setUint32(24,content.length,true);
    cv.setUint16(28,filename.length,true);cv.setUint32(42,offset,true);
    centers.push(central,filename);
    offset+=local.length+filename.length+content.length;
  }
  const centerBytes=concat(centers),end=new Uint8Array(22),ev=new DataView(end.buffer);
  ev.setUint32(0,0x06054b50,true);ev.setUint16(8,files.length,true);
  ev.setUint16(10,files.length,true);ev.setUint32(12,centerBytes.length,true);
  ev.setUint32(16,offset,true);
  return concat([...locals,centerBytes,end]);
}
const open="<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";
const relsNS="http://schemas.openxmlformats.org/package/2006/relationships";
const mainNS="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const ctNS="http://schemas.openxmlformats.org/package/2006/content-types";
const rootRels=type=>open+'<Relationships xmlns="'+relsNS+'"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="'+type+'"/></Relationships>';
function contentTypes(overrides){
  const base=[open,'<Types xmlns="'+ctNS+'">','<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>','<Default Extension="xml" ContentType="application/xml"/>'];
  for(const [name,type] of overrides)base.push('<Override PartName="/'+name+'" ContentType="'+type+'"/>');
  return base.join("")+"</Types>";
}
function docx(text,title){
  const lines=[title,...text.split(/\r?\n/).slice(0,400)].filter(Boolean);
  const paragraphs=lines.map((line,i)=>'<w:p>'+(i===0?'<w:pPr><w:jc w:val="center"/></w:pPr>':'')+
    '<w:r><w:rPr>'+(i===0?'<w:b/><w:sz w:val="32"/>':'<w:sz w:val="22"/>')+'</w:rPr><w:t xml:space="preserve">'+xml(line)+'</w:t></w:r></w:p>').join("");
  const document=open+'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+paragraphs+
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="900" w:right="900" w:bottom="900" w:left="900"/></w:sectPr></w:body></w:document>';
  return zip([
    ["[Content_Types].xml",contentTypes([["word/document.xml","application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"]])],
    ["_rels/.rels",rootRels("word/document.xml")],["word/document.xml",document]
  ]);
}
function colName(n){let s="";for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
function xlsx(text){
  const rows=text.replace(/\r/g,"").split("\n").slice(0,300).map(line=>
    (line.includes("\t")?line.split("\t"):line.includes(",")?line.split(","):[line]).slice(0,26));
  const sheetRows=rows.map((cells,r)=>'<row r="'+(r+1)+'">'+cells.map((val,c)=>{
    const ref=colName(c)+(r+1),value=String(val||"");
    if(/^[-+]?\d+(?:\.\d+)?$/.test(value.trim()))return '<c r="'+ref+'"><v>'+value.trim()+'</v></c>';
    const formula=value.match(/^=\s*(SUM|AVERAGE|MIN|MAX|COUNT)\([A-Z]{1,2}\d+(?::[A-Z]{1,2}\d+)?\)$/i);
    if(formula)return '<c r="'+ref+'"><f>'+xml(value.trim().slice(1))+'</f><v>0</v></c>';
    return '<c r="'+ref+'" t="inlineStr"><is><t xml:space="preserve">'+xml(value)+'</t></is></c>';
  }).join("")+'</row>').join("");
  const sheet=open+'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>'+sheetRows+'</sheetData></worksheet>';
  const workbook=open+'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="'+mainNS+'"><sheets><sheet name="NibrasGPT" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const relationships=open+'<Relationships xmlns="'+relsNS+'"><Relationship Id="rId1" Type="'+mainNS+'/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
  return zip([
    ["[Content_Types].xml",contentTypes([["xl/workbook.xml","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"],["xl/worksheets/sheet1.xml","application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"]])],
    ["_rels/.rels",rootRels("xl/workbook.xml")],["xl/workbook.xml",workbook],["xl/_rels/workbook.xml.rels",relationships],["xl/worksheets/sheet1.xml",sheet]
  ]);
}
function pptx(text,title){
  const p="http://schemas.openxmlformats.org/presentationml/2006/main", a="http://schemas.openxmlformats.org/drawingml/2006/main",r=mainNS;
  const attrs=' xmlns:p="'+p+'" xmlns:a="'+a+'" xmlns:r="'+r+'"';
  const group='<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  const lines=text.split(/\r?\n/).filter(Boolean).slice(0,60);
  const shape=(id,name,body,x,y,w,h,size)=>'<p:sp><p:nvSpPr><p:cNvPr id="'+id+'" name="'+xml(name)+'"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="'+x+'" y="'+y+'"/><a:ext cx="'+w+'" cy="'+h+'"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>'+body.map(t=>'<a:p><a:r><a:rPr lang="en-US" sz="'+size+'"/><a:t>'+xml(t)+'</a:t></a:r></a:p>').join("")+'</p:txBody></p:sp>';
  const slideCount=Math.min(12,Math.max(1,Math.ceil(lines.length/6)));
  const slideParts=[];
  for(let i=0;i<slideCount;i++){
    const block=lines.slice(i*6,(i+1)*6);
    const heading=i===0?title:title+" — "+(i+1);
    const shapes=shape(2,"Slide title",[heading],550000,340000,7900000,970000,3300)+shape(3,"Content",block.length?block:[""],650000,1440000,7800000,3360000,1800);
    slideParts.push(["ppt/slides/slide"+(i+1)+".xml",open+'<p:sld'+attrs+'><p:cSld><p:spTree>'+group+shapes+'</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>']);
    slideParts.push(["ppt/slides/_rels/slide"+(i+1)+".xml.rels",open+'<Relationships xmlns="'+relsNS+'"><Relationship Id="rId1" Type="'+r+'/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>']);
  }
  const sldIds=Array.from({length:slideCount},(_,i)=>'<p:sldId id="'+(256+i)+'" r:id="rId'+(i+2)+'"/>').join("");
  const presentation=open+'<p:presentation'+attrs+'><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>'+sldIds+'</p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>';
  const prels=open+'<Relationships xmlns="'+relsNS+'"><Relationship Id="rId1" Type="'+r+'/slideMaster" Target="slideMasters/slideMaster1.xml"/>'+Array.from({length:slideCount},(_,i)=>'<Relationship Id="rId'+(i+2)+'" Type="'+r+'/slide" Target="slides/slide'+(i+1)+'.xml"/>').join("")+'</Relationships>';
  const master=open+'<p:sldMaster'+attrs+'><p:cSld><p:spTree>'+group+'</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';
  const layout=open+'<p:sldLayout'+attrs+' type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>'+group+'</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
  const theme=open+'<a:theme xmlns:a="'+a+'" name="NibrasGPT"><a:themeElements><a:clrScheme name="NibrasGPT"><a:dk1><a:srgbClr val="182429"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>'+["dk2","lt2","accent1","accent2","accent3","accent4","accent5","accent6","hlink","folHlink"].map((key,i)=>'<a:'+key+'><a:srgbClr val="'+["333333","F8F8F8","0C6667","5A86C6","A4C9CC","D1A58A","8D7EBC","D7E4E6","0C6667","5A86C6"][i]+'"/></a:'+key+'>').join("")+'</a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>';
  const parts=[
    ["_rels/.rels",rootRels("ppt/presentation.xml")],
    ["ppt/presentation.xml",presentation],
    ["ppt/_rels/presentation.xml.rels",prels],
    ["ppt/slideMasters/slideMaster1.xml",master],
    ["ppt/slideMasters/_rels/slideMaster1.xml.rels",open+'<Relationships xmlns="'+relsNS+'"><Relationship Id="rId1" Type="'+r+'/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="'+r+'/theme" Target="../theme/theme1.xml"/></Relationships>'],
    ["ppt/slideLayouts/slideLayout1.xml",layout],
    ["ppt/slideLayouts/_rels/slideLayout1.xml.rels",open+'<Relationships xmlns="'+relsNS+'"><Relationship Id="rId1" Type="'+r+'/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>'],
    ["ppt/theme/theme1.xml",theme],
    ...slideParts
  ];
  const types=[["ppt/presentation.xml","application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"],["ppt/slideMasters/slideMaster1.xml","application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"],["ppt/slideLayouts/slideLayout1.xml","application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"],["ppt/theme/theme1.xml","application/vnd.openxmlformats-officedocument.theme+xml"]];
  for(let i=0;i<slideCount;i++)types.push(["ppt/slides/slide"+(i+1)+".xml","application/vnd.openxmlformats-officedocument.presentationml.slide+xml"]);
  return zip([["[Content_Types].xml",contentTypes(types)],...parts]);
}
function pdf(text,title){
  if(/[^\u0009\u000a\u000d\u0020-\u007e\u00a0-\u00ff]/u.test(text+title))
    throw new Error("PDF multilingual font embedding is not yet available. Export DOCX for Tamil, or use browser Print to PDF.");
  const lines=[title,"",...text.replace(/\r/g,"").split("\n")].flatMap(line=>{
    const out=[];let a=String(line);while(a.length>96){out.push(a.slice(0,96));a=a.slice(96);}out.push(a);return out;
  });
  const groups=[];for(let i=0;i<lines.length;i+=48)groups.push(lines.slice(i,i+48));
  const objects=[null],add=value=>{objects.push(value);return objects.length-1;};
  const catalog=add(""),pages=add(""),font=add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),pageIds=[];
  const pdfLine=x=>x.replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)").replace(/[^\x20-\x7e]/g,"?");
  for(const group of groups){
    const content="BT /F1 11 Tf 45 775 Td 14 TL "+group.map((line,i)=> (i?"T* ":"")+"("+pdfLine(line)+") Tj").join("\n")+" ET";
    const stream=add("<< /Length "+utf8(content).length+" >>\nstream\n"+content+"\nendstream");
    pageIds.push(add("<< /Type /Page /Parent "+pages+" 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 "+font+" 0 R >> >> /Contents "+stream+" 0 R >>"));
  }
  objects[catalog]="<< /Type /Catalog /Pages "+pages+" 0 R >>";
  objects[pages]="<< /Type /Pages /Count "+pageIds.length+" /Kids ["+pageIds.map(id=>id+" 0 R").join(" ")+"] >>";
  let bytes=utf8("%PDF-1.4\n");const offsets=[0];
  for(let i=1;i<objects.length;i++){
    offsets.push(bytes.length);
    bytes=concat([bytes,utf8(i+" 0 obj\n"+objects[i]+"\nendobj\n")]);
  }
  const xref=bytes.length;
  bytes=concat([bytes,utf8("xref\n0 "+objects.length+"\n0000000000 65535 f \n"+
    offsets.slice(1).map(pos=>String(pos).padStart(10,"0")+" 00000 n \n").join("")+
    "trailer\n<< /Size "+objects.length+" /Root "+catalog+" 0 R >>\nstartxref\n"+xref+"\n%%EOF")]);
  return bytes;
}
export function buildOfficeDocument({format,text,title="NibrasGPT Document"}){
  const type=String(format||"").toLowerCase();
  const allowed=["docx","xlsx","pptx","pdf"];
  if(!allowed.includes(type))throw new Error("Unsupported file type. Select DOCX, XLSX, PPTX or PDF.");
  const body=clip(text,30000),header=clip(title,90).trim()||"NibrasGPT Document";
  if(!body.trim())throw new Error("There is no content to export.");
  const files={docx:()=>docx(body,header),xlsx:()=>xlsx(body),pptx:()=>pptx(body,header),pdf:()=>pdf(body,header)};
  const mimes={
    docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pdf:"application/pdf"
  };
  const filename=header.replace(/[^a-z0-9_-]/gi,"-").replace(/-+/g,"-").slice(0,42)||"NibrasGPT";
  return {bytes:files[type](),contentType:mimes[type],filename:filename+"."+type};
}
