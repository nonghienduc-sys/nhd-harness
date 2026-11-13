import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../dist/db.js';
import { PdfService } from '../dist/pdf.js';
import { PersistentJsonWorker } from '../dist/persistent-json-worker.js';

async function makePdf(path, text='Hello cached PDF') {
  const content=`BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g,v=>`\\${v}`)}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let output='%PDF-1.4\n'; const offsets=[0];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(output,'latin1'));output+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(output,'latin1');
  output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(path,Buffer.from(output,'latin1'));
}

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'nhd-pdf-speed-')); const pdf=join(dir,'sample.pdf'); await makePdf(pdf,'First cached version');
  const store=new Store(join(dir,'state.sqlite'));
  const files={resolvePath(p){return resolve(String(p));}};
  const intake={resolvePath(p){return resolve(String(p));}};
  const config={intakeEnabled:true,ocrEnabled:true,emergencyStop:false};
  return {dir,pdf,store,service:new PdfService(config,store,files,intake)};
}

test('persistent PDF worker keeps one process across bounded read-only requests',async()=>{
  const script=resolve('office','pdf_worker.py'); const worker=new PersistentJsonWorker('pdf-test','python',[script,'--persistent'],process.cwd());
  try{
    const one=await worker.request({action:'status'},20000); const pid1=worker.status().pid;
    const two=await worker.request({action:'status'},20000); const status=worker.status();
    assert.equal(one.available,true); assert.equal(two.available,true); assert.ok(pid1); assert.equal(status.pid,pid1); assert.equal(status.requests,2); assert.equal(status.failures,0);
  }finally{worker.stop();}
});

test('native PDF document/page cache preserves content and invalidates when file identity changes',async()=>{
  const f=await fixture();
  try{
    const inspection=await f.service.inspect(f.pdf); assert.equal(inspection.pages,1);
    const first=await f.service.read(f.pdf,1,1,5000); assert.match(first.pages[0].text,/First cached version/);
    const search=await f.service.search(f.pdf,'cached'); assert.equal(search.hits.length,1);
    let cache=f.service.cacheStatus(); assert.ok(cache.metrics.documentHits>=2); assert.ok(cache.metrics.pageHits>=2);
    await makePdf(f.pdf,'Second changed cached version with a different byte length');
    const second=await f.service.read(f.pdf,1,1,5000); assert.match(second.pages[0].text,/Second changed cached version/);
    cache=f.service.cacheStatus(); assert.ok(cache.metrics.documentMisses>=2);
  }finally{f.service.dispose();f.store.db.close();}
});

test('PDF render cache reuses exact content-version page output',async()=>{
  const f=await fixture();
  try{
    const one=await f.service.render(f.pdf,[1],900); const two=await f.service.render(f.pdf,[1],900);
    assert.equal(one.images.length,1); assert.equal(two.images.length,1); assert.equal(two.images[0].data,one.images[0].data);
    const cache=f.service.cacheStatus(); assert.ok(cache.metrics.renderHits>=1); assert.equal(cache.worker.online,true);
  }finally{f.service.dispose();f.store.db.close();}
});

test('OCR result cache is version/content keyed and preserves exact returned text',async(t)=>{
  const f=await fixture();
  try{
    const status=await f.service.status(); if(!status.ocr.engines.tesseract.available){t.skip('Tesseract unavailable');return;}
    const one=await f.service.ocr(f.pdf,[1],'eng','tesseract'); const two=await f.service.ocr(f.pdf,[1],'eng','tesseract');
    assert.equal(two.cache.resultHit,true); assert.deepEqual(two.pages,one.pages);
    const cache=f.service.cacheStatus(); assert.ok(cache.metrics.ocrHits>=1);
  }finally{f.service.dispose();f.store.db.close();}
});


test('persistent PDF worker preserves UTF-8 Unicode paths',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nhd-pdf-unicode-'));
  const unicodeDir=join(dir,'Khoá luận tốt nghiệp'); await mkdir(unicodeDir,{recursive:true});
  const pdf=join(unicodeDir,'Bài mẫu.pdf'); await makePdf(pdf,'Unicode path PDF');
  const store=new Store(join(dir,'state.sqlite'));
  const files={resolvePath(p){return resolve(String(p));}}; const intake={resolvePath(p){return resolve(String(p));}};
  const service=new PdfService({intakeEnabled:true,ocrEnabled:true,emergencyStop:false},store,files,intake);
  try{
    const rendered=await service.render(pdf,[1],900);
    assert.equal(rendered.images.length,1); assert.equal(rendered.path,resolve(pdf));
    assert.doesNotMatch(String(rendered.path),/Ã|áº|á»/);
  }finally{service.dispose();store.db.close();}
});
