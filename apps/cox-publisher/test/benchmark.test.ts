import assert from "node:assert/strict";
import test from "node:test";
import { ContinuousBenchmark, pythPriceE8, type BenchmarkAnchor, type BenchmarkObservation } from "../src/benchmark.ts";
import type { PythBatch } from "../src/pyth-cache.ts";

const anchor: BenchmarkAnchor={universeDigest:"a".repeat(64),timestampUs:0n,benchmark:100_000_000_000_000n,
  assets:[{assetId:"btc",feedId:"1",priceE8:100n},{assetId:"eth",feedId:"2",priceE8:100n}]};
const batch=(timestampUs:bigint,prices:bigint[]):PythBatch=>({timestampUs,prices:prices.map((price,index)=>({feedId:String(index+1),price,exponent:-8,confidence:1n})),signedSolana:new Uint8Array([1])});
function harness() {
  const observations:BenchmarkObservation[]=[];let failed=false;let verified=0;const activations:BenchmarkAnchor[]=[];
  const service=new ContinuousBenchmark(anchor,{verifyPythBatch:async data=>{verified++;if(data.signedSolana[0]!==1)throw new Error("Invalid signature");},
    history:{append:async data=>{if(failed)throw new Error("storage failure");observations.push(data);},activate:async data=>{if(failed)throw new Error("storage failure");activations.push(data);}}});
  return{service,observations,activations,verified:()=>verified,fail:(value:boolean)=>{failed=value;}};
}
test("off-chain benchmark advances during quiet on-chain periods and uses fixed geometric anchors",async()=>{
  const h=harness();const first=await h.service.observe(batch(1n,[121n,100n]));assert.equal(first.benchmark,110_000_000_000_000n);
  await h.service.observe(batch(2n,[100n,121n]));const last=await h.service.observe(batch(3n,[100n,100n]));
  assert.equal(last.benchmark,anchor.benchmark);assert.equal(h.observations.length,3);assert.equal(h.verified(),3);
  const preview=h.service.preview()!;preview.signedPayload.fill(0);assert.equal(h.service.preview()!.signedPayload[0],1);
});
test("duplicate observations are idempotent, equivocation and time regression fail closed",async()=>{
  const h=harness();await h.service.observe(batch(2n,[100n,100n]));await h.service.observe(batch(2n,[100n,100n]));assert.equal(h.observations.length,1);
  await assert.rejects(h.service.observe(batch(2n,[101n,100n])),/ConflictingBenchmarkObservation/);
  await assert.rejects(h.service.observe(batch(1n,[100n,100n])),/BenchmarkTimeRegression/);
  await assert.rejects(h.service.observe({...batch(3n,[100n,100n]),signedSolana:new Uint8Array([0])}),/Invalid signature/);
});
test("inclusion anchors at the current level and signed prices without creating an index jump",async()=>{
  const h=harness();const old=await h.service.observe(batch(1n,[121n,100n,25n]));
  const next:BenchmarkAnchor={universeDigest:"b".repeat(64),timestampUs:1n,benchmark:old.benchmark,assets:[
    {...anchor.assets[0]!,priceE8:121n},anchor.assets[1]!,{assetId:"sol",feedId:"3",priceE8:25n}]};
  await assert.rejects(h.service.activate({...next,assets:[...next.assets.slice(0,2),{...next.assets[2]!,priceE8:26n}]}),/InvalidBenchmarkUniverseTransition/);
  await h.service.activate(next);assert.equal(h.activations.length,1);
  assert.equal((await h.service.observe(batch(1n,[121n,100n,25n]))).benchmark,old.benchmark);
  assert.equal((await h.service.observe(batch(2n,[242n,200n,50n]))).benchmark,2n*old.benchmark);
});
test("failed persistence never changes the public preview or activates an anchor",async()=>{
  const h=harness();h.fail(true);await assert.rejects(h.service.observe(batch(1n,[100n,100n])),/storage failure/);assert.equal(h.service.preview(),null);
  h.fail(false);await h.service.observe(batch(1n,[100n,100n,25n]));h.fail(true);
  await assert.rejects(h.service.activate({...anchor,universeDigest:"b".repeat(64),timestampUs:1n}),/storage failure/);
  h.fail(false);assert.equal((await h.service.observe(batch(2n,[100n,100n]))).universeDigest,anchor.universeDigest);
});
test("price scaling rejects values outside the shared integer representation",()=>{
  assert.equal(pythPriceE8(12345n,-10),123n);assert.equal(pythPriceE8(12350n,-10),124n);
  assert.throws(()=>pythPriceE8(1n,-18),/InvalidBenchmarkPrice/);
  assert.throws(()=>pythPriceE8(1n<<64n,0),/InvalidBenchmarkPrice/);
});
