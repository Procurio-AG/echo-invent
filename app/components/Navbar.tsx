"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/pricing", label: "Pricing" },
  { href: "/categorize", label: "Categorize" },
  { href: "/worklist", label: "Worklist" },
  { href: "/image-capture", label: "Images" },
  { href: "/mobile-scanner", label: "Mobile Scanner" },
  { href: "/rapid-capture", label: "Rapid Capture" },
  { href: "/desktop-scanner", label: "Desktop Scanner" },
];

export function Navbar() {
  const pathname = usePathname();

  return (
    <header className="border-b border-border bg-surface/60 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="font-serif text-xl tracking-tight">
          ECHO
        </Link>
        <ul className="flex items-center gap-1">
          {links.map((link) => {
            const active =
              link.href === "/"
                ? pathname === "/"
                : pathname.startsWith(link.href);
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "bg-border text-text"
                      : "text-muted hover:text-text"
                  }`}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
