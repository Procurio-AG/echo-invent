import type { Metadata } from "next";
import { Toaster } from "react-hot-toast";
import { Navbar } from "./components/Navbar";
import "./globals.css";

export const metadata: Metadata = {
  title: "ECHO — Inventory Audit",
  description: "Session-based grocery inventory reconciliation.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>
        <Navbar />
        <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
        <Toaster
          position="top-center"
          toastOptions={{
            style: {
              background: "#141416",
              color: "#f3f3f5",
              border: "1px solid #26262b",
            },
          }}
        />
      </body>
    </html>
  );
}
