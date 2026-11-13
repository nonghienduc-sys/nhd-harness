import test from "node:test";
import assert from "node:assert/strict";
import { planVideoMaterials, prepareMaterialRightsReview } from "../dist/material-planner.js";

const rec = (id, title, provider="commons", opts={}) => ({
 asset_id:id, provider, external_id:id, title, kind:opts.kind??"video",
 source_url:"https://commons.wikimedia.org/wiki/File:"+id, media_url:opts.media_url??"https://upload.wikimedia.org/"+id+".webm",
 preview_url:null, author:"Alice", license:opts.license??"CC BY 4.0",
 rights_status:provider==="youtube"?"reference_only":"license_review",
 width:opts.width??1920, height:opts.height??1080, duration_seconds:20,
});
const scene=(id, query, startSeconds=0, strategy="stock")=>({
 id, query, startSeconds, durationSeconds:8, visual:"Explanation "+id, strategy,
});
const request=(scenes, more={})=>({
 title:"How API works",scenes,orientation:"landscape",
 providers:["commons","openverse"],candidatesPerScene:3,enableImageFallback:true,...more,
});
const fake=(lookup)=>async o=>({
 assets:lookup(o),notes:{},providers:o.providers,query:o.query,kind:o.kind,orientation:o.orientation,
});

test("graphics-only scene never queries providers and remains blocked from stock import",async()=>{
 let count=0;
 const plan=await planVideoMaterials(request([scene("mapping","API software network",0,"graphics")]),{
   discover: async()=>{count++;throw Error("Must never search");}
 });
 assert.equal(count,0);
 assert.equal(plan.scenes[0].importGate,"graphics_only");
 assert.equal(plan.statistics.approvedAssets,0);
 assert.equal(plan.statistics.importableAssets,0);
});
test("real video candidate is ranked with rights and attribution evidence, not auto-approved",async()=>{
 const plan=await planVideoMaterials(request([scene("waiter","restaurant waiter serving customer")]),{
   discover:fake(o=>o.kind==="video"?[
    rec("p1","Restaurant waiter serving customer at restaurant"),
    rec("p2","Ocean boat in waves",{width:1920,height:1080})
   ]:[])
 });
 const entry=plan.scenes[0];
 assert.equal(entry.recommendedAssetId,"p1");
 assert.equal(entry.candidates[0].asset.asset_id,"p1");
 assert.ok(entry.candidates[0].score>entry.candidates[1].score);
 assert.equal(entry.candidates[0].rights.status,"manual_review_required");
 assert.equal(entry.candidates[0].rights.mayImportToTimeline,false);
 assert.match(entry.candidates[0].rights.suggestedAttribution,/Alice/);
 assert.equal(entry.importGate,"blocked_pending_rights");
 assert.equal(plan.safety.noMediaDownloaded,true);
});
test("YouTube reference is never recommended even if perfect keyword match",async()=>{
 const y=rec("ref","Restaurant waiter serving customer","youtube");
 const plan=await planVideoMaterials(request([scene("waiter","restaurant waiter serving customer")],{
   providers:["youtube"],enableImageFallback:false
 }),{discover:fake(()=>[y])});
 assert.equal(plan.scenes[0].recommendedAssetId,null);
 assert.equal(plan.scenes[0].candidates[0].rights.status,"reference_only");
 assert.equal(plan.scenes[0].candidates[0].rights.mayImportToTimeline,false);
});
test("images are fallback only if video results are not relevant",async()=>{
 let calls=0;
 const plan=await planVideoMaterials(request([scene("kitchen","chef cooking pho restaurant")]),{
   discover:fake(o=>{calls++;return o.kind==="video"?[rec("wrong","Random forest footage", "commons")]:
     [rec("photo","Chef cooking pho restaurant","openverse",{kind:"image",width:2000,height:1000})];})
 });
 assert.equal(calls,2);
 assert.equal(plan.scenes[0].recommendedAssetId,"photo");
 assert.equal(plan.scenes[0].sourceQueries.length,2);
});
test("repeated image query only consumes one discovery call and duplicate penalty is applied",async()=>{
 let calls=0;
 const first=scene("a","honeybee native apis cerana",0);
 const second=scene("b","honeybee native apis cerana",8);
 const plan=await planVideoMaterials(request([first,second],{enableImageFallback:false}),{
   discover:async () => {calls++;return {assets:[rec("h1","Honeybee native apis cerana")],notes:{}};}
 });
 assert.equal(calls,1);
 assert.equal(plan.scenes[0].recommendedAssetId,"h1");
 assert.ok(plan.scenes[1].candidates[0].reasons.some(x=>x.includes("Penalized")));
});
test("timing must be monotonic and 300s hard cap", async()=>{
 await assert.rejects(planVideoMaterials(request([
   {...scene("a","api network",0),durationSeconds:12},scene("b","restaurant",8)
 ])),/TIMELINE_INVALID/);
 await assert.rejects(planVideoMaterials(request([scene("a","api network",300)])),/TIMELINE_INVALID/);
});
test("license CC BY-SA requires ShareAlike review rather than approval",()=>{
 const r=prepareMaterialRightsReview({asset:rec("foo","Hive", "commons",{license:"CC BY-SA 4.0"}),intendedUse:"commercial"});
 assert.equal(r.reviewStatus,"pending_human_verification");
 assert.equal(r.readyForEditorImport,false);
 assert.ok(r.rights.restrictions.some(x=>x.includes("ShareAlike")));
 assert.ok(r.requiredEvidence.some(x=>x.includes("Local file hash")));
});
test("stock provider terms flagged even for educational video",()=>{
 const r=prepareMaterialRightsReview({asset:rec("foo","Forest", "pexels",{license:"Pexels License"}),intendedUse:"educational"});
 assert.equal(r.readyForEditorImport,false);
 assert.ok(r.rights.restrictions.some(x=>x.includes("stock terms")));
});
test("invalid provider never reaches network",async()=>{
 await assert.rejects(planVideoMaterials(request([scene("a","api network")],{providers:["evil"]})),/PROVIDER_LIST_INVALID/);
});
test("no sufficient relevance leaves graphics fallback",async()=>{
 const plan=await planVideoMaterials(request([scene("a","restaurant waiter serving customer")]),{
   discover:fake(()=>[rec("x","Forest trees and hills")])
 });
 assert.equal(plan.scenes[0].recommendedAssetId,null);
 assert.match(plan.scenes[0].recommendation,/No sufficiently relevant/);
});
