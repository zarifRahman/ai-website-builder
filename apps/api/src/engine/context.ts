import type { FileNode } from "@aab/shared";
import { readFileContent, readFileTree } from "../projects/workspace.js";

/**
 * Context assembler for the Opus codegen turn.
 *
 * Builds the STABLE system prefix — system prompt + project conventions +
 * file tree + a few relevant files — as the first blocks of the request, so
 * Anthropic prompt caching can reuse it across turns. `cache_control`
 * goes on the LAST stable block (the relevant-files block); the volatile
 * user message is appended after, per the Opus 4.8 contract.
 */

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface BuiltContext {
  system: SystemBlock[];
  fileTree: FileNode[];
}

export const SYSTEM_PROMPT =
  "You are an AI coding assistant that edits a Vite + React + TypeScript web app " +
  "by calling the text_editor tool (str_replace_based_edit_tool). " +
  "You can view, create, edit, and insert text in files under the project workspace. " +
  "Use view first to read files before editing them, prefer small str_replace edits " +
  "with enough context to be unique, and keep components under src/. " +
  "Every change you make must keep the project building (the build runs tsc + vite). " +
  "When you are done, reply with a short summary instead of making more tool calls.";

export const PROJECT_CONVENTIONS =
  "Vite + React + TypeScript app (Tailwind CSS available). Source files live under " +
  "src/, with src/main.tsx as the entry point and src/App.tsx as the root component. " +
  "TypeScript strict mode is on; avoid unused imports and variables. " +
  "Keep diffs minimal and localized to the requested change.";

const PRIORITY_FILES = [
  "package.json",
  "index.html",
  "src/App.tsx",
  "src/App.jsx",
  "src/main.tsx",
  "src/index.css",
  "src/App.css",
  "src/index.ts",
  "src/index.js",
  "vite.config.ts",
  "tailwind.config.js",
  "tailwind.config.ts",
];

const MAX_RELEVANT_FILES = 8;
const MAX_FILE_CHARS = 6000;

function collectFiles(tree: FileNode[], out: string[] = []): string[] {
  for (const node of tree) {
    if (node.type === "file") {
      out.push(node.path);
    } else if (node.children) {
      collectFiles(node.children, out);
    }
  }
  return out;
}

export function treeToText(tree: FileNode[]): string {
  const lines: string[] = [];
  const walk = (nodes: FileNode[], indent: string): void => {
    for (const node of nodes) {
      lines.push(`${indent}${node.type === "dir" ? node.name + "/" : node.name}`);
      if (node.children) walk(node.children, indent + "  ");
    }
  };
  walk(tree, "");
  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n... [truncated]";
}

/** Flatten the cached system prefix: prompt + conventions + tree + relevant files. */
export async function buildContext(projectId: string): Promise<BuiltContext> {
  const tree = await readFileTree(projectId).catch(
    () => [] as FileNode[],
  );
  const treeText = treeToText(tree);
  const stable = [
    SYSTEM_PROMPT,
    "## Project conventions",
    PROJECT_CONVENTIONS,
    "## Project file tree",
    treeText.length > 0 ? treeText : "(empty workspace)",
  ].join("\n");

  const allFiles = collectFiles(tree);
  const selected: string[] = [];
  for (const p of PRIORITY_FILES) {
    if (allFiles.includes(p)) selected.push(p);
  }
  for (const p of allFiles) {
    if (selected.length >= MAX_RELEVANT_FILES) break;
    if (!selected.includes(p)) selected.push(p);
  }

  const parts: string[] = ["## Relevant file contents"];
  if (selected.length === 0) {
    parts.push("(none found)");
  } else {
    for (const rel of selected) {
      let content: string;
      try {
        content = await readFileContent(projectId, rel);
      } catch {
        continue;
      }
      parts.push(`\n--- ${rel} ---\n${truncate(content, MAX_FILE_CHARS)}`);
    }
  }
  const relevant = parts.join("\n");

  return {
    system: [
      { type: "text" as const, text: stable },
      { type: "text" as const, text: relevant, cache_control: { type: "ephemeral" as const } },
    ],
    fileTree: tree,
  };
}
