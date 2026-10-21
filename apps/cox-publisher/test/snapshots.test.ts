import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AdaptiveSnapshots, BenchmarkArchive } from "../src/snapshots.ts";
import type { AdaptivePlan } from "../src/adaptive.ts";
import type { PythBatch } from "../src/pyth-cache.ts";
const anchor={universeDigest:"a".repeat(64),timestampUs:0n,benchmark:100_000_000_000_000n,
 assets:[{assetId:"BTC",feedId:"1",priceE8:100n},{assetId:"ETH",feedId:"2",priceE8:100n}]};
const batch=(timestampUs:bigint,price=121n):PythBatch=>({timestampUs,prices:[{feedId:"1",price,exponent:-8,confidence:1n},{feedId:"2",price:100n,exponent:-8,confidence:1n}],signedSolana:Uint8Array.of(1)});
const plan:AdaptivePlan={stateId:"pool-state",methodologyId:"methodology",sequence:5n,work:[{kind:"basic-request",id:"request",eligibleAfterMs:1000,assetIds:["BTC"]}],requiredAssetIds:["BTC","ETH"],closingTimestampMs:null};
test("idle benchmark survives restart, preserves exact closing prices and refuses old feed replays",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"adaptive-snapshots-"));try{
 let now=2000;const options={anchor,methodologyId:"methodology",maxEntryAgeMs:2000,nowMs:()=>now,archive:new BenchmarkArchive(directory),verifyPythBatch:async(value:PythBatch)=>{assert.equal(value.signedSolana[0],1);}};
 const first=await AdaptiveSnapshots.open(options);await first.ingest(batch(2_000_000n));assert.equal(first.preview()!.benchmark,110_000_000_000_000n);
 assert.equal((await first.select(plan))!.previousStateId,plan.stateId);
 const resumed=await AdaptiveSnapshots.open(options);assert.equal(resumed.preview()!.id,first.preview()!.id);
 await assert.rejects(resumed.ingest(batch(1_000_000n)),/BenchmarkTimeRegression/);
 now=10_000;await resumed.ingest(batch(10_000_000n,400n));
 const close=await resumed.select({...plan,closingTimestampMs:2000});assert.equal(close!.benchmark,110_000_000_000_000n);assert.equal(close!.oracleTimestampMs,2000);
 assert.equal(await resumed.select({...plan,closingTimestampMs:3000}),null);
 now=20_000;assert.equal(await resumed.select(plan),null);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test("unverified prices, corrupt durable state and changed anchors fail closed",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"adaptive-snapshots-"));try{
 const options={anchor,methodologyId:"methodology",maxEntryAgeMs:1000,nowMs:()=>2000,archive:new BenchmarkArchive(directory),verifyPythBatch:async()=>{throw new Error("bad signature");}};
 const service=await AdaptiveSnapshots.open(options);await assert.rejects(service.ingest(batch(2_000_000n)),/bad signature/);assert.equal(service.preview(),null);
 await assert.rejects(AdaptiveSnapshots.open({...options,anchor:{...anchor,benchmark:1n}}),/AnchorMismatch/);
 await writeFile(join(directory,"latest.json"),'{"id":"corrupt"}');await assert.rejects(AdaptiveSnapshots.open(options),/InvalidBenchmarkArchive/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
