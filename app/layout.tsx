import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "paper between us",
  description:
    "A two-person drawing app for virtual date nights — one sheet of paper, two brushes, a shared prompt.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#fbfaf7",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // STSong (prompts, names, title) and Stratos light (utility) are local
  // fonts — no webfont loading; the stacks in globals.css carry fallbacks.
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
