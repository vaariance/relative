"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

export function RowLink({ href, className = "", children }: { href: string; className?: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <tr
      onMouseEnter={() => router.prefetch(href)}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button")) return;
        if (event.metaKey || event.ctrlKey) window.open(href, "_blank");
        else router.push(href);
      }}
      className={`cursor-pointer ${className}`}
    >
      {children}
    </tr>
  );
}
