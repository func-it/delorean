import type { Metadata, Viewport } from "next";
import { Barlow, Barlow_Semi_Condensed } from "next/font/google";

import "./globals.css";

// Barlow takes after California road signs: Hill Valley's own lettering.
const barlow = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-barlow",
});
const barlowSemiCondensed = Barlow_Semi_Condensed({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-barlow-semi-condensed",
});

export const metadata: Metadata = {
  title: { default: "Delorean, le vidéoclub", template: "%s · Delorean" },
  description: "Écrivez votre panier de DVD comme vous voulez : nous le lisons, le code calcule le prix.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eceef0" },
    { media: "(prefers-color-scheme: dark)", color: "#101214" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" className={`${barlow.variable} ${barlowSemiCondensed.variable}`}>
      <body>{children}</body>
    </html>
  );
}
