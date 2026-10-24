import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import anchor, { type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { EpochInstructions, epochAddresses, epochEntryFee } from "../src/epoch.ts";
import { integer } from "../src/wire.ts";
import { build } from "esbuild";

const idl=JSON.parse(readFileSync(new URL("../../cox-epoch/idl/epoch.json",import.meta.url),"utf8")) as Idl;
const program=new anchor.Program(idl,{connection:new Connection("https://api.devnet.solana.com")});
const coder=new anchor.BorshInstructionCoder(program.idl);
const key=(byte:number)=>new PublicKey(new Uint8Array(32).fill(byte));
const admin=key(1),operator=key(2),owner=key(3),mint=key(4),source=key(5);
const pdas=epochAddresses(program.programId);const selection={config:pdas.config(admin,0n),opensAt:144_000n};
const basket=Array.from({length:30},(_,i)=>i);

test("Epoch PDA addresses bind the configured pool, UTC boundary and individual entry nonce",()=>{
  const epoch=pdas.epoch(selection);
  assert.ok(epoch.equals(PublicKey.findProgramAddressSync([Buffer.from("epoch"),selection.config.toBuffer(),integer(selection.opensAt,8)],program.programId)[0]));
  assert.notEqual(pdas.lot(epoch,0n).toBase58(),pdas.lot(epoch,1n).toBase58());
  assert.throws(()=>pdas.epoch({...selection,opensAt:144_001n}),/InvalidEpochBoundary/);
  assert.throws(()=>pdas.lot(epoch,-1n),/IntegerOutOfRange/);
});
test("current-round preparation is canonical, bounded, permissionless and resumable",()=>{
  const sdk=new EpochInstructions(program),binding={assetRegistry:key(6),registryVersion:key(7),methodology:key(8)};
  const instructions=sdk.prepareCurrentEpoch(owner,mint,selection,binding,{accountBytes:null,copiedAssets:0,assetCount:31,sealed:false});
  const decoded=instructions.map(instruction=>coder.decode(instruction.data)!);
  assert.equal(decoded[0]!.name,"initializeCurrentEpoch");
  assert.equal(decoded.at(-1)!.name,"sealCurrentEpoch");
  let growth=0;
  for(const value of decoded.filter(value=>value.name==="growCurrentEpoch")){
    const amount=(value.data as {additionalBytes:number}).additionalBytes;
    assert.ok(amount>0&&amount<=8192);growth+=amount;
  }
  assert.equal(growth,64000-2048);
  assert.deepEqual(decoded.filter(value=>value.name==="copyRegistryAssets").map(value=>value.data),[
    {start:0,count:8},{start:8,count:8},{start:16,count:8},{start:24,count:7},
  ]);
  assert.ok(instructions.every(instruction=>instruction.keys.filter(key=>key.isSigner).every(key=>key.pubkey.equals(owner))));
  const resumed=sdk.prepareCurrentEpoch(operator,mint,selection,binding,{accountBytes:64000,copiedAssets:16,assetCount:31,sealed:false});
  assert.deepEqual(resumed.map(instruction=>coder.decode(instruction.data)!.name),["copyRegistryAssets","copyRegistryAssets","sealCurrentEpoch"]);
  assert.deepEqual(sdk.prepareCurrentEpoch(owner,mint,selection,binding,{accountBytes:64000,copiedAssets:0,assetCount:31,sealed:true}),[]);
  assert.throws(()=>sdk.prepareCurrentEpoch(owner,mint,selection,binding,{accountBytes:null,copiedAssets:1,assetCount:31,sealed:false}),/InvalidEpochPreparation/);
  assert.throws(()=>sdk.copyRegistryAssets(owner,selection,binding,254,2),/InvalidEpochPage/);
  assert.ok(sdk.finalizeEmpty(selection).keys.every(key=>!key.isSigner));
});
test("registry-bound configuration and lifecycle encode the generated ABI",()=>{
  const sdk=new EpochInstructions(program),registry=key(6);
  const normal=sdk.initializeRegistryConfig(admin,mint,1n,operator,new Uint8Array(32).fill(9),100000000000000n,5n,4096,registry);
  const dual=sdk.initializeRegistryConfig(admin,mint,1n,operator,new Uint8Array(32).fill(9),100000000000000n,5n,4096,registry,key(7));
  assert.equal(coder.decode(normal.data)!.name,"initializeRegistryConfig");
  assert.equal(coder.decode(dual.data)!.name,"initializeRegistryDevnetConfig");
  assert.equal(coder.decode(sdk.setConfigLifecycle(admin,selection.config,"archived").data)!.name,"setConfigLifecycle");
  assert.throws(()=>sdk.initializeRegistryConfig(admin,mint,1n,operator,new Uint8Array(32).fill(9),100000000000000n,5n,4096,PublicKey.default),/InvalidEpochConfiguration/);
});
test("Epoch SDK encodes every lifecycle operation with the generated contract ABI",()=>{
  const sdk=new EpochInstructions(program);
  const calls=[sdk.initializeConfig(admin,mint,0n,operator,new Uint8Array(32).fill(9),1000n,3n,1000),
    sdk.initializeEpoch(admin,mint,selection),sdk.growEpoch(admin,selection,8192),
    sdk.appendUniverse(admin,selection,[{id:0,feedId:new Uint8Array(32).fill(1),originPrice:1000n}]),sdk.sealEpoch(admin,selection),
    sdk.queue(selection,{nonce:0n,owner,collateralAccount:source,grossStake:10_000_000n,basket,backedAsset:0}),
    sdk.publishSnapshot(operator,selection.config,1n,144_001n,1000n,basket.map(id=>({assetId:id,feedId:new Uint8Array(32).fill(id+1),value:1000n}))),
    sdk.execute(operator,selection,0n,1n),sdk.beginClose(operator,selection,2n),sdk.score(selection,0n),sdk.finalizeScores(selection),
    sdk.allocate(selection,0n),sdk.refund(selection,0n),sdk.voidEpoch(selection),sdk.withdraw(owner,source,selection,0n),sdk.withdrawFees(admin,source,selection,1n),
    sdk.closeSnapshot(operator,selection.config,1n),sdk.withdrawPartial(owner,source,selection,0n,1n),sdk.initializeDevnetConfig(admin,mint,key(6),1n,operator,new Uint8Array(32).fill(9),1000n,3n,1000)];
  for(const instruction of calls){const decoded=coder.decode(instruction.data);assert.ok(decoded);
    const definition=program.idl.instructions.find(item=>item.name===decoded.name)!;
    assert.equal(instruction.keys.length,definition.accounts.length);
    definition.accounts.forEach((account,index)=>{assert.ok(!("accounts" in account));if("accounts" in account)return;
      assert.equal(instruction.keys[index]!.isSigner,account.signer??false);assert.equal(instruction.keys[index]!.isWritable,account.writable??false);});}
  const deposit=coder.decode(calls[5]!.data)!.data as {basket:number[]};assert.deepEqual(deposit.basket,basket);
});
test("basket restrictions and twenty-cent capped fees fail before transaction construction",()=>{
  assert.equal(epochEntryFee(10_000_000n),2000n);assert.equal(epochEntryFee(10_000_000_000n),200_000n);
  assert.throws(()=>epochEntryFee(0n),/InvalidEpochStake/);
  const sdk=new EpochInstructions(program);const prediction={nonce:0n,owner,collateralAccount:source,grossStake:1n,basket,backedAsset:0};
  assert.throws(()=>sdk.queue(selection,{...prediction,basket:basket.slice(1)}),/InvalidEpochBasket/);
  assert.throws(()=>sdk.queue(selection,{...prediction,basket:[...basket.slice(0,29),0]}),/InvalidEpochBasket/);
  assert.throws(()=>sdk.queue(selection,{...prediction,backedAsset:31}),/InvalidEpochBasket/);
  assert.throws(()=>sdk.publishSnapshot(operator,selection.config,1n,144_001n,1000n,[]),/InvalidAtomicEpochSnapshot/);
});
test("Epoch SDK bundles for browsers without server credentials or signing dependencies",async()=>{
  const result=await build({entryPoints:[new URL("../src/epoch.ts",import.meta.url).pathname],bundle:true,platform:"browser",format:"esm",write:false,metafile:true});
  assert.ok(result.outputFiles[0]!.contents.length>0);
  assert.ok(Object.keys(result.metafile!.inputs).every(path=>!path.includes("apps/signer")&&!path.includes("@eox/signing")));
});
test("paged immutable snapshots expose the exact generated ABI and bounded price pages",()=>{
  const sdk=new EpochInstructions(program);const prices=basket.slice(0,8).map(assetId=>({assetId,feedId:new Uint8Array(32).fill(assetId+1),value:1000n}));
  const calls=[sdk.initializeSnapshot(operator,selection.config,3n,144_001n,1000n,30),
    sdk.growSnapshot(operator,selection.config,3n,8192),sdk.appendPrices(operator,selection.config,3n,prices),sdk.sealSnapshot(operator,selection.config,3n)];
  assert.deepEqual(calls.map(call=>coder.decode(call.data)!.name),["initializeSnapshot","growSnapshot","appendPrices","sealSnapshot"]);
  for(const call of calls) assert.ok(call.keys.find(key=>key.pubkey.equals(pdas.snapshot(selection.config,3n))));
  assert.throws(()=>sdk.appendPrices(operator,selection.config,3n,[prices[1]!,prices[0]!]),/InvalidEpochPage/);
  assert.throws(()=>sdk.appendPrices(operator,selection.config,3n,[...prices,prices[0]!]),/InvalidEpochPage/);
  assert.throws(()=>sdk.initializeSnapshot(operator,selection.config,3n,144_001n,1000n,257),/InvalidEpochPage/);
});

test("snapshot rent returns only to the bound operator through exact config and snapshot PDAs",()=>{
  const instruction=new EpochInstructions(program).closeSnapshot(operator,selection.config,7n);
  assert.equal(coder.decode(instruction.data)!.name,"closeSnapshot");
  assert.deepEqual(instruction.keys.map(key=>[key.pubkey.toBase58(),key.isWritable,key.isSigner]),[
    [operator.toBase58(),true,true],[selection.config.toBase58(),false,false],[pdas.snapshot(selection.config,7n).toBase58(),true,false]]);
  assert.throws(()=>new EpochInstructions(program).closeSnapshot(operator,selection.config,-1n),/IntegerOutOfRange/);
});
