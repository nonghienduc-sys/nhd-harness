import test from 'node:test';
import assert from 'node:assert/strict';
import { OcrDispatcher, chooseOcrEngine, normalizePaddleLanguage } from '../dist/ocr.js';

test('OCR dispatcher prefers PaddleOCR in auto mode', () => {
  assert.equal(chooseOcrEngine('auto', { paddleocr: true, tesseract: true }), 'paddleocr');
  assert.equal(chooseOcrEngine('auto', { paddleocr: false, tesseract: true }), 'tesseract');
});

test('OCR dispatcher enforces explicitly requested engine availability', () => {
  assert.throws(() => chooseOcrEngine('paddleocr', { paddleocr: false, tesseract: true }), /PaddleOCR/);
  assert.throws(() => chooseOcrEngine('tesseract', { paddleocr: true, tesseract: false }), /Tesseract/);
  assert.throws(() => chooseOcrEngine('auto', { paddleocr: false, tesseract: false }), /No OCR engine/);
});

test('PaddleOCR language normalization maps Vietnamese and English aliases', () => {
  assert.equal(normalizePaddleLanguage('vie+eng'), 'vi');
  assert.equal(normalizePaddleLanguage('vi'), 'vi');
  assert.equal(normalizePaddleLanguage('eng'), 'en');
  assert.equal(normalizePaddleLanguage('en'), 'en');
});

test('auto mode falls back to Tesseract when PaddleOCR execution fails', async () => {
  const dispatcher = new OcrDispatcher('Z:/synthetic');
  dispatcher.paddleStatus = async () => ({ available: true });
  dispatcher.runPaddle = async () => { throw new Error('synthetic paddle failure'); };
  let tesseractCalls = 0;
  const result = await dispatcher.runPdf({
    path: 'scan.pdf',
    pages: [1],
    language: 'vie+eng',
    requestedEngine: 'auto',
    tesseractAvailable: true,
    render: async () => ({ images: [{ page: 1, mimeType: 'image/png', data: '', width: 1, height: 1 }] }),
    runTesseract: async () => {
      tesseractCalls += 1;
      return { pages: [{ page: 1, text: 'HS-482', confidence: 93.5 }] };
    },
  });
  assert.equal(tesseractCalls, 1);
  assert.equal(result.engine, 'tesseract');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.requestedEngine, 'auto');
  assert.match(result.warnings[0], /PaddleOCR failed/);
  assert.equal(result.pages[0].engine, 'tesseract');
  assert.equal(result.pages[0].text, 'HS-482');
});


test('concurrent PaddleOCR failures retire the shared worker without null-stop races', async () => {
  const dispatcher = new OcrDispatcher('Z:/synthetic');
  let stops=0;
  dispatcher.paddleWorker={
    request: async()=>{ await new Promise(r=>setTimeout(r,5)); throw new Error('persistent failed'); },
    stop: ()=>{stops+=1;},
    status: ()=>({online:true})
  };
  dispatcher.runProcess=async()=>{ throw new Error('oneshot failed'); };
  const settled=await Promise.allSettled([
    dispatcher.paddleRequest({action:'ocr'},1000),
    dispatcher.paddleRequest({action:'ocr'},1000),
  ]);
  assert.equal(settled.every(item=>item.status==='rejected'),true);
  for(const item of settled){
    assert.doesNotMatch(String(item.reason),/Cannot read properties of null|reading ['"]stop['"]/);
    assert.match(String(item.reason),/Persistent PaddleOCR failed/);
  }
  assert.ok(stops>=1);
  assert.equal(dispatcher.paddleWorker,null);
});
