import { createHash } from "node:crypto";
import anchor, { BN, type Program } from "@coral-xyz/anchor";
import { PublicKey, type Connection, type AccountInfo } from "@solana/web3.js";
import { addresses, decodeAccount, committedRequest, epochAddresses, type Pool, type Request, type Batch } from "@cox/client";
import type { AdaptiveChainState, AdaptiveWork } from "./adaptive.ts";

type Enum = Readonly<Record<string, unknown>>;
export interface EpochChainAccount {
  config: PublicKey; opensAt: BN; vault: PublicKey; testVault: PublicKey;
  state: null | { opensAt: BN; closesAt: BN; phase: Enum; nextNonce: BN;
    universe: { id: number; feedId: number[]; originPrice: BN }[];
    closingSnapshot: null | { sequence: BN }; ledger: { pendingGross: BN; activeNet: BN } };
}
export interface EpochChainLot {
  epoch: PublicKey; nonce: BN; state: null | { admittedAt: BN; basket: number[]; state: Enum };
}
export interface AdaptiveChainOptions {
  connection: Connection; basicProgram: Program; basicPoolId: bigint; epochProgram: Program; epochConfig: PublicKey;
  methodologyId: string; assetIds: readonly string[]; nextSequence(): Promise<bigint>;
}
export interface DetailedAdaptiveChainState {
  view: AdaptiveChainState; basicPool: Pool; basicStage: Batch | null;
  basicRequests: readonly { address: PublicKey; value: Request }[];
  epochs: readonly { address: PublicKey; value: EpochChainAccount }[];
  lots: readonly { address: PublicKey; value: EpochChainLot }[];
  slot: number;
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const number = (value: BN) => { const result = Number(value.toString()); if (!Number.isSafeInteger(result)) throw new Error("AdaptiveTimestampOverflow"); return result; };
const is = (value: Enum, kind: string) => Object.keys(value).length === 1 && Object.hasOwn(value, kind);

export class SolanaAdaptiveChain {
  constructor(private readonly options: AdaptiveChainOptions) {
    if (!options.assetIds.length || new Set(options.assetIds).size !== options.assetIds.length) throw new Error("InvalidAdaptiveRoster");
  }
  async read(): Promise<AdaptiveChainState> { return (await this.readDetailed()).view; }
  async readDetailed(): Promise<DetailedAdaptiveChainState> {
    const o = this.options, basic = addresses(o.basicProgram.programId), epoch = epochAddresses(o.epochProgram.programId);
    const poolKey = basic.pool(o.basicPoolId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const base = await o.connection.getMultipleAccountsInfoAndContext([basic.registry(), poolKey, o.epochConfig], { commitment: "confirmed" });
      if (base.value.some(value => !value)) throw new Error("AdaptivePoolNotInitialized");
      const registry = decodeAccount(o.basicProgram, "registry", base.value[0]!);
      const pool = decodeAccount(o.basicProgram, "pool", base.value[1]!);
      if (registry.paused || pool.schemaVersion !== 4 || !pool.poolId.eq(new BN(o.basicPoolId.toString()))
        || !pool.registry.equals(basic.registry()) || !pool.vault.equals(basic.vault(poolKey))) throw new Error("AdaptiveBasicPoolUnavailable");
      const config = this.epochDecode<{methodology:number[]}>("poolConfig", base.value[2]!);
      if (hex(new Uint8Array(config.methodology)) !== o.methodologyId) throw new Error("AdaptiveMethodologyMismatch");
      const scans = await Promise.all([
        o.connection.getProgramAccounts(o.basicProgram.programId, { commitment:"confirmed", minContextSlot:base.context.slot, withContext:true,
          filters:[{memcmp:{offset:0,bytes: this.discriminator(o.basicProgram,"request")}}, {memcmp:{offset:11,bytes:poolKey.toBase58()}}] }),
        o.connection.getProgramAccounts(o.epochProgram.programId, { commitment:"confirmed", minContextSlot:base.context.slot, withContext:true,
          filters:[{memcmp:{offset:0,bytes:this.discriminator(o.epochProgram,"epochAccount")}}, {memcmp:{offset:8,bytes:o.epochConfig.toBase58()}}] }),
        o.connection.getProgramAccounts(o.epochProgram.programId, { commitment:"confirmed", minContextSlot:base.context.slot, withContext:true,
          filters:[{memcmp:{offset:0,bytes:this.discriminator(o.epochProgram,"lotAccount")}}] }),
      ]);
      const stageInfo = pool.stage ? await o.connection.getAccountInfo(pool.stage,{commitment:"confirmed",minContextSlot:base.context.slot}) : null;
      const end = await o.connection.getMultipleAccountsInfoAndContext([basic.registry(),poolKey,o.epochConfig], {commitment:"confirmed", minContextSlot:Math.max(...scans.map(scan=>scan.context.slot))});
      if (end.value.some((info,index)=>!info || !info.data.equals(base.value[index]!.data))) continue;
      const epochCheck=await o.connection.getMultipleAccountsInfoAndContext(scans[1].value.map(item=>item.pubkey),{commitment:"confirmed",minContextSlot:end.context.slot});
      if(epochCheck.value.some((info,index)=>!info||!info.data.equals(scans[1].value[index]!.account.data)))continue;
      const stage = stageInfo ? decodeAccount(o.basicProgram,"batch",stageInfo) : null;
      if (pool.stage && (!stage || !pool.stage.equals(basic.batch(poolKey)) || !stage.pool.equals(poolKey)
        || !stage.predecessorSequence.eq(pool.sequence) || hex(new Uint8Array(stage.predecessorDigest))!==hex(new Uint8Array(pool.stateDigest)))) throw new Error("AdaptiveStageMismatch");
      const requests = scans[0].value.map(item=>({address:item.pubkey,value:committedRequest(decodeAccount(o.basicProgram,"request",item.account),pool)}));
      for (const item of requests) if (!item.value.pool.equals(poolKey) || !item.address.equals(basic.request(poolKey,BigInt(item.value.nonce.toString())))) throw new Error("AdaptiveRequestMismatch");
      const epochs = scans[1].value.map(item=>({address:item.pubkey,value:this.epochDecode<EpochChainAccount>("epochAccount",item.account)}));
      for (const item of epochs) if (!item.value.config.equals(o.epochConfig) || !item.address.equals(epoch.epoch({config:o.epochConfig,opensAt:BigInt(item.value.opensAt.toString())}))) throw new Error("AdaptiveEpochMismatch");
      const epochKeys = new Set(epochs.map(item=>item.address.toBase58()));
      const lots = scans[2].value.map(item=>({address:item.pubkey,value:this.epochDecode<EpochChainLot>("lotAccount",item.account)})).filter(item=>epochKeys.has(item.value.epoch.toBase58()));
      for (const item of lots) if (!item.address.equals(epoch.lot(item.value.epoch,BigInt(item.value.nonce.toString())))) throw new Error("AdaptiveLotMismatch");
      const pending:AdaptiveWork[]=[];
      const maintenance:{id:string;pool:"basic"|"epoch"}[]=[];
      if(stage)maintenance.push({id:poolKey.toBase58(),pool:"basic"});
      if (!stage) for (const item of requests.filter(item=>item.value.status===0)) pending.push({kind:"basic-request",id:item.address.toBase58(),eligibleAfterMs:(number(pool.origin)+number(item.value.targetBatch))*1000-1,assetIds:o.assetIds});
      for (const item of epochs) {
        const state=item.value.state;if(!state)continue;
        if(!is(state.phase,"open")){if(is(state.phase,"scoring")||is(state.phase,"allocating"))maintenance.push({id:item.address.toBase58(),pool:"epoch"});continue;}
        const closed=number(state.closesAt)*1000<=Date.now();
        if(closed && lots.some(lot=>lot.value.epoch.equals(item.address)&&lot.value.state&&is(lot.value.state.state,"pending")))maintenance.push({id:item.address.toBase58(),pool:"epoch"});
        const assets=state.universe.map(asset=>this.asset(asset.id));
        if (!state.ledger.activeNet.isZero()) pending.push({kind:"epoch-close",id:item.address.toBase58(),closingTimestampMs:number(state.closesAt)*1000,assetIds:assets});
        for (const lot of lots.filter(lot=>lot.value.epoch.equals(item.address))) if(!closed&&lot.value.state&&is(lot.value.state.state,"pending")) pending.push({kind:"epoch-prediction",id:lot.address.toBase58(),eligibleAfterMs:number(lot.value.state.admittedAt)*1000,assetIds:lot.value.state.basket.map(id=>this.asset(id))});
      }
      const stateId=createHash("sha256").update(Buffer.concat([...base.value.map(info=>info!.data),...epochs.map(item=>scans[1].value.find(raw=>raw.pubkey.equals(item.address))!.account.data)])).digest("hex");
      const deadlines=epochs.flatMap(item=>item.value.state&&is(item.value.state.phase,"open")?[number(item.value.state.closesAt)*1000]:[]);
      return {view:{stateId,methodologyId:o.methodologyId,nextSequence:await o.nextSequence(),requiredAssetIds:o.assetIds,pending,maintenance,nextClosingDeadlineMs:deadlines.length?Math.min(...deadlines):null},basicPool:pool,basicStage:stage,basicRequests:requests,epochs,lots,slot:end.context.slot};
    }
    throw new Error("AdaptiveInconsistentRead");
  }
  private asset(id:number):string {const value=this.options.assetIds[id];if(!value)throw new Error("AdaptiveUnknownAsset");return value;}
  private discriminator(program:Program,name:string):string {
    const definition=program.idl.accounts?.find(account=>account.name===name);if(!definition)throw new Error("AdaptiveAccountInterfaceMismatch");
    return anchor.utils.bytes.bs58.encode(new Uint8Array(definition.discriminator));
  }
  private epochDecode<T>(name:string,info:AccountInfo<Buffer>):T {if(!info.owner.equals(this.options.epochProgram.programId))throw new Error("AdaptiveAccountOwnerMismatch");return this.options.epochProgram.coder.accounts.decode(name,info.data) as T;}
}
