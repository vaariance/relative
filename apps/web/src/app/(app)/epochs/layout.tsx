import type { ReactNode } from "react";
import { EpochPicksProvider } from "@/components/epoch-picks";

export default function EpochsLayout({ children }: { children: ReactNode }) {
  return <EpochPicksProvider>{children}</EpochPicksProvider>;
}
