import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ItemResult } from "./batch.js";

const COLUMNS: (keyof ItemResult)[] = ["key", "projectId", "integrationId", "outcome", "via", "detail", "evidence"];

export function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text; // evita fórmula ao abrir no Excel/Sheets
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(results: ItemResult[]): string {
  return [COLUMNS.join(","), ...results.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

export function writeReport(path: string, results: ItemResult[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "﻿" + toCsv(results), "utf8"); // BOM: acentos certos no Excel
}
