"use client";

import { Geist_Mono } from "next/font/google";
import { DownPage } from "@/components/down-page";
import "./globals.css";

const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export default function GlobalError() {
  return (
    <html lang="en" className={mono.variable}>
      <body className="min-h-screen antialiased">
        <DownPage />
      </body>
    </html>
  );
}
