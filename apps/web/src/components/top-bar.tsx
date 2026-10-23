"use client";

import { Activity, ArrowLeftRight, BarChart3, Droplets, Timer, Home, PanelLeftClose, PanelLeftOpen, Wallet, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { allows } from "@/lib/consent";
import { stencilPath } from "@/landing/stencil-glyphs";
import { CookieSettingsButton } from "./cookie-consent";
import { NetworkSwitcher } from "./network-switcher";
import { TreeNav } from "./tree-nav";
import { WalletButton } from "./wallet-button";

type Item = { href: string; label: string; icon: LucideIcon };

const main: Item[] = [
  { href: "/markets", label: "Markets", icon: BarChart3 },
  { href: "/crypto", label: "$CRYPTO", icon: Activity },
  { href: "/portfolio", label: "Portfolio", icon: Wallet },
  { href: "/swap", label: "Swap", icon: ArrowLeftRight },
  { href: "/epochs", label: "Epochs", icon: Timer },
];

const more: Item[] = [
  { href: "/faucet", label: "Faucet", icon: Droplets },
];

const wordmark = stencilPath("RELATIVE", 1, 0.34);

function isCurrent(pathname: string, href: string): boolean {
  if (href === "/markets") return pathname.startsWith("/markets") || pathname.startsWith("/assets");
  return pathname.startsWith(href);
}

function Wordmark() {
  return (
    <Link href="/markets" aria-label="Relative" className="flex items-center text-ink">
      <svg aria-hidden="true" viewBox={`-0.5 -0.5 ${wordmark.width + 1} 7`} className="h-5 w-auto overflow-visible">
        <path d={wordmark.path} fill="none" stroke="currentColor" strokeWidth={1} />
      </svg>
    </Link>
  );
}

const STORE = "relative-sidebar";

export function SideBar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const items = [...main, ...more];
  const active = items.find((item) => isCurrent(pathname, item.href))?.href;

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORE) === "collapsed");
    } catch {
      setCollapsed(false);
    }
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      if (allows("preferences")) window.localStorage.setItem(STORE, next ? "collapsed" : "open");
      else window.localStorage.removeItem(STORE);
    } catch {
      return;
    }
  };

  const Toggle = collapsed ? PanelLeftOpen : PanelLeftClose;
  const control = "grid size-9 shrink-0 cursor-pointer place-items-center rounded-control text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink";

  return (
    <aside
      className={`sticky top-0 hidden h-screen shrink-0 flex-col gap-8 overflow-hidden border-r border-line bg-bg py-4 lg:flex ${
        collapsed ? "w-[60px] px-3" : "w-56 px-4"
      }`}
    >
      <div className={`flex h-10 items-center ${collapsed ? "justify-center" : "justify-between pl-2"}`}>
        {!collapsed && <Wordmark />}
        <button type="button" onClick={toggle} aria-expanded={!collapsed} aria-label={collapsed ? "Open the menu" : "Collapse the menu"} title={collapsed ? "Open the menu" : "Collapse the menu"} className={control}>
          <Toggle size={16} aria-hidden="true" />
        </button>
      </div>
      <nav aria-label="Main" className="flex-1">
        {collapsed ? (
          <ul className="flex flex-col items-center gap-1">
            {items.map((item) => {
              const current = item.href === active;
              return (
                <li key={item.href}>
                  <Link href={item.href} aria-label={item.label} title={item.label} aria-current={current ? "page" : undefined} className={`${control} ${current ? "bg-surface-2 text-accent hover:text-accent" : ""}`}>
                    <item.icon size={16} aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <TreeNav items={items.map(({ href, label }) => ({ href, label }))} activeHref={active} />
        )}
      </nav>
      {collapsed ? (
        <Link href="/" aria-label="Home page" title="Home page" className={`${control} self-center`}>
          <Home size={16} aria-hidden="true" />
        </Link>
      ) : (
        <div className="flex flex-col">
          <Link href="/" className="flex h-9 items-center gap-2.5 whitespace-nowrap rounded-control px-2 text-[13px] text-muted transition-colors duration-150 hover:text-ink">
            <Home size={15} aria-hidden="true" />
            Home page
          </Link>
          <Link href="/terms" className="flex h-9 items-center gap-2.5 whitespace-nowrap rounded-control px-2 text-[13px] text-muted transition-colors duration-150 hover:text-ink">Terms of Use</Link>
          <Link href="/privacy" className="flex h-9 items-center gap-2.5 whitespace-nowrap rounded-control px-2 text-[13px] text-muted transition-colors duration-150 hover:text-ink">Privacy Policy</Link>
          <CookieSettingsButton className="flex h-9 cursor-pointer items-center gap-2.5 whitespace-nowrap rounded-control px-2 text-left text-[13px] text-muted transition-colors duration-150 hover:text-ink" />
        </div>
      )}
    </aside>
  );
}

export function TopBar() {
  const pathname = usePathname();
  const items = [...main, ...more];
  const title = items.find((item) => isCurrent(pathname, item.href))?.label ?? "";

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bar backdrop-blur-xl">
      <div className="flex h-14 w-full items-center gap-3 px-4 sm:px-6">
        <div className="lg:hidden">
          <Wordmark />
        </div>
        <span className="hidden text-sm font-medium text-ink lg:block">{title}</span>
        <div className="ml-auto flex items-center gap-2">
          <NetworkSwitcher />
          <WalletButton />
        </div>
      </div>
      <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden">
        {items.map((item) => {
          const current = isCurrent(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={current ? "page" : undefined}
              className={`flex h-10 shrink-0 items-center gap-2 rounded-pill px-3 text-sm transition-colors duration-150 ${
                current ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"
              }`}
            >
              <item.icon size={15} aria-hidden="true" className={current ? "text-accent" : undefined} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
