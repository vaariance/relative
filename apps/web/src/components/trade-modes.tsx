import Link from "next/link";

const tab = "rounded-pill px-4 py-1.5 text-sm transition-colors duration-150";

export function TradeModes({ current }: { current: "basic" | "epoch" }) {
  const modes = [
    { id: "basic", label: "Basic", href: "/markets" },
    { id: "epoch", label: "Epoch", href: "/epochs" },
  ] as const;
  return (
    <nav aria-label="Trade mode" className="inline-flex rounded-pill bg-surface p-1">
      {modes.map((mode) =>
        mode.id === current ? (
          <span key={mode.id} aria-current="page" className={`${tab} bg-surface-2 font-medium text-ink`}>
            {mode.label}
          </span>
        ) : (
          <Link key={mode.id} href={mode.href} className={`${tab} text-muted hover:text-ink`}>
            {mode.label}
          </Link>
        ),
      )}
    </nav>
  );
}
