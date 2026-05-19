import type { Metadata, Viewport } from "next";
import "./globals.css";
import SW from "@/components/SW";

export const metadata: Metadata = {
  title: "Hujjaj Connect",
  description: "Billoo Travels — Hajj field operations",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Hujjaj Connect" },
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#1f6b4a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <SW />
      </body>
    </html>
  );
}
