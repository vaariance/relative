import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { CookieConsent } from "@/components/cookie-consent";
import "./globals.css";

const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  metadataBase: new URL("https://getrelative.trade"),
  title: "Relative",
  description: "Crypto price performance relative to the benchmark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={mono.variable}>
      <body className="min-h-screen antialiased">
        {children}
        <CookieConsent />
      </body>
    </html>
  );
}
