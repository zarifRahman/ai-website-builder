"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";

function subscribe(onChange: () => void) {
  window.addEventListener("aab-theme", onChange);
  return () => window.removeEventListener("aab-theme", onChange);
}

function getSnapshot() {
  return document.documentElement.classList.contains("dark");
}

function getServerSnapshot() {
  return false;
}

/** Toggles `.dark` on <html> and persists the choice. */
export function ThemeToggle() {
  const isDark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* ignore storage errors */
    }
    window.dispatchEvent(new Event("aab-theme"));
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={toggle}
      aria-pressed={isDark}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {isDark ? "Light" : "Dark"}
    </Button>
  );
}
