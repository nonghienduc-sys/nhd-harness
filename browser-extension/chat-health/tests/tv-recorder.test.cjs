const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const context = { URL };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "tv-recorder-core.js"), "utf8"), context, { filename: "tv-recorder-core.js" });
const C = context.NHDFibRecorderCore;

test("only official HTTPS TradingView chart URLs are eligible", () => {
  assert.equal(C.isTradingViewChart("https://www.tradingview.com/chart/abcd/"), true);
  assert.equal(C.isTradingViewChart("https://tradingview.com/chart/"), true);
  assert.equal(C.isTradingViewChart("https://eviltradingview.com/chart/"), false);
  assert.equal(C.isTradingViewChart("http://www.tradingview.com/chart/"), false);
  assert.equal(C.isTradingViewChart("https://www.tradingview.com/account/"), false);
});
test("parse two separately labeled Fibonacci prices, not context or bar index", () => {
  const parsed = C.parseCoordinates([
    {label:"Price 1",value:"75,600.50"},
    {label:"Price 2",value:"72,100.25"},
    {label:"Bar #",value:"12132"},
    {label:"Price 1 Bar Number",value:"504"},
  ]);
  assert.equal(parsed.anchors.price1.numeric,75600.5);
  assert.equal(parsed.anchors.price2.numeric,72100.25);
  assert.equal(parsed.anchors.price3,undefined);
  assert.equal(parsed.verified,false);
  assert.equal(parsed.confidence,"dom_exact_labels_unverified");
});
test("supports third anchor but never silently verifies it",()=>{
  const parsed=C.parseCoordinates([{label:"Giá 1",value:"100.1"},{label:"Giá 2",value:"200.2"},{label:"Giá 3",value:"300.3"}]);
  assert.equal(Object.keys(parsed.anchors).length,3);
  assert.equal(parsed.verified,false);
});
test("duplicate coordinate labels stay ambiguous",()=>{
  const p=C.parseCoordinates([{label:"Price 1",value:"3"},{label:"Price 1",value:"4"},{label:"Price 2",value:"6"}]);
  assert.equal(p.ambiguous.join(","),"price1");
  assert.equal(p.anchors.price1,undefined);
  assert.equal(p.confidence,"insufficient_or_ambiguous");
});
test("no implicit price from generic fields or mouse pixels",()=>{
  const p=C.parseCoordinates([{label:"",value:"75000"},{label:"x",value:"200"}]);
  assert.equal(Object.keys(p.anchors).length,0);
  assert.equal(p.verified,false);
});
test("bounded export cannot claim to have validated a strategy or executed an order",()=>{
  const a=C.prepareExport({events:Array.from({length:1000},(_,i)=>({id:i})),captures:Array.from({length:17},(_,i)=>({id:i}))});
  assert.equal(a.readOnly,true);assert.equal(a.events.length,600);assert.equal(a.captures.length,12);
  assert.equal(a.status,"observation_not_validated_strategy");
});
