import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { ThemeToggle } from "@/components/ThemeToggle";

export function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span
            className="flex h-6 w-6 items-center justify-center rounded bg-primary text-xs text-primary-foreground"
            aria-hidden="true"
          >
            A
          </span>
          AI App Builder
        </Link>
        <nav className="flex items-center gap-2" aria-label="Primary">
          <ThemeToggle />
          <Button size="sm">Log in</Button>
        </nav>
      </div>
    </header>
  );
}
