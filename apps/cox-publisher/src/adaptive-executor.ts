import anchor from "@coral-xyz/anchor";
import { createPublicKey, verify } from "node:crypto";
import { getTransactionDecoder } from "@solana/transactions";
import { PublicKey } from "@solana/web3.js";
import type { AdaptiveChainState, AdaptivePlan, AdaptiveSnapshot, PreparedAdaptivePublication } from "./adaptive.ts";

export interface DurableAdaptivePublication extends PreparedAdaptivePublication {
  readonly signature: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}
export interface AdaptiveExecutionDraft {
  readonly unsignedTransaction: Uint8Array;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}
export interface AdaptiveExecutorOptions {
  readonly operator: PublicKey;
  readonly preparePublication: (plan:AdaptivePlan,snapshot:AdaptiveSnapshot)=>Promise<AdaptiveExecutionDraft>;
  readonly prepareMaintenance: (state:AdaptiveChainState,work:{id:string;pool:"basic"|"epoch"})=>Promise<AdaptiveExecutionDraft>;
  readonly sign: (transaction:Uint8Array)=>Promise<Uint8Array>;
  readonly rpc: {
    simulate(transaction:Uint8Array):Promise<{err:unknown}>;
    send(transaction:Uint8Array):Promise<string>;
    status(signature:string):Promise<null|{err:unknown;confirmationStatus:"processed"|"confirmed"|"finalized"|null}>;
    blockHeight():Promise<number>;
  };
}

export class SolanaAdaptiveExecutor {
  constructor(private readonly options:AdaptiveExecutorOptions) {}
  async prepare(plan:AdaptivePlan,snapshot:AdaptiveSnapshot):Promise<DurableAdaptivePublication> {
    return this.prepareDraft(await this.options.preparePublication(plan,snapshot));
  }
  async prepareMaintenance(state:AdaptiveChainState,work:{id:string;pool:"basic"|"epoch"}):Promise<DurableAdaptivePublication> {
    return this.prepareDraft(await this.options.prepareMaintenance(state,work));
  }
  private async prepareDraft(draft:AdaptiveExecutionDraft):Promise<DurableAdaptivePublication> {
    if(!Number.isSafeInteger(draft.lastValidBlockHeight)||draft.lastValidBlockHeight<0||!draft.blockhash)throw new Error("InvalidAdaptiveLifetime");
    const transaction=await this.options.sign(draft.unsignedTransaction);
    const unsigned=getTransactionDecoder().decode(draft.unsignedTransaction),signed=getTransactionDecoder().decode(transaction);
    if(!Buffer.from(unsigned.messageBytes).equals(Buffer.from(signed.messageBytes)))throw new Error("AdaptiveSignerMessageMismatch");
    const entries=Object.entries(signed.signatures);
    if(entries.length!==1||entries[0]![0]!==this.options.operator.toBase58())throw new Error("AdaptiveSignerIdentityMismatch");
    const signature=entries[0]![1];if(!signature)throw new Error("AdaptiveMissingSignature");
    const key=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),this.options.operator.toBuffer()]),format:"der",type:"spki"});
    if(!verify(null,new Uint8Array(signed.messageBytes),key,signature))throw new Error("AdaptiveSignatureInvalid");
    const id=anchor.utils.bytes.bs58.encode(signature);
    const prepared={id,signature:id,transaction:new Uint8Array(transaction),blockhash:draft.blockhash,lastValidBlockHeight:draft.lastValidBlockHeight};
    const simulation=await this.options.rpc.simulate(prepared.transaction);
    if(simulation.err!==null)throw new Error("AdaptiveSimulationFailed:"+JSON.stringify(simulation.err));
    return prepared;
  }
  async submit(publication:PreparedAdaptivePublication):Promise<void> {
    const pending=this.checked(publication);
    if(await this.options.rpc.blockHeight()>pending.lastValidBlockHeight)return;
    const signature=await this.options.rpc.send(pending.transaction);
    if(signature!==pending.signature)throw new Error("AdaptiveSubmissionSignatureMismatch");
  }
  async reconcile(publication:PreparedAdaptivePublication):Promise<"pending"|"accepted"|"expired"> {
    const pending=this.checked(publication),status=await this.options.rpc.status(pending.signature);
    if(status && (status.confirmationStatus==="confirmed"||status.confirmationStatus==="finalized"))return status.err===null?"accepted":"expired";
    if(status)return "pending";
    if(await this.options.rpc.blockHeight()>pending.lastValidBlockHeight){
      const after=await this.options.rpc.status(pending.signature);
      if(after)return after.confirmationStatus==="confirmed"||after.confirmationStatus==="finalized"?after.err===null?"accepted":"expired":"pending";
      return "expired";
    }
    await this.submit(pending);
    return "pending";
  }
  private checked(publication:PreparedAdaptivePublication):DurableAdaptivePublication {
    const pending=publication as DurableAdaptivePublication;
    if(typeof pending.signature!=="string"||pending.signature!==pending.id||!Number.isSafeInteger(pending.lastValidBlockHeight)||pending.lastValidBlockHeight<0||typeof pending.blockhash!=="string")throw new Error("AdaptiveCheckpointMetadataMissing");
    const tx=getTransactionDecoder().decode(pending.transaction),entries=Object.entries(tx.signatures);
    if(entries.length!==1||entries[0]![0]!==this.options.operator.toBase58()||!entries[0]![1]||anchor.utils.bytes.bs58.encode(entries[0]![1]!)!==pending.signature)throw new Error("AdaptiveCheckpointSignatureMismatch");
    const key=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),this.options.operator.toBuffer()]),format:"der",type:"spki"});
    if(!verify(null,new Uint8Array(tx.messageBytes),key,entries[0]![1]!))throw new Error("AdaptiveCheckpointSignatureInvalid");
    return pending;
  }
}
