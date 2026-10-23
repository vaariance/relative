import { FaucetPanel } from "@/components/faucet-panel";

export default function FaucetPage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <h1 className="font-display text-title font-semibold tracking-tight">Devnet Faucet</h1>
      <FaucetPanel />
    </div>
  );
}
