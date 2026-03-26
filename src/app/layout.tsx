import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Somnia Whale Tracker",
  description: "Real-time on-chain whale activity powered by Somnia Reactivity",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        {children}
      </body>
    </html>
  );
}