/** Arquivos de execução: checkpoint (o que já foi feito) e snapshot (estado antes de mudar). JSONL só cresce. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IntegrationStatus } from "./client.js";

export interface CheckpointEntry {
  key: string;
  status: "done" | "failed" | "rolled_back";
  at: string;
  detail?: string;
}

export interface SnapshotEntry {
  key: string;
  projectId: string;
  integrationId: string;
  before: IntegrationStatus;
  at: string;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

function append(path: string, entry: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

export class Checkpoint {
  private latest = new Map<string, CheckpointEntry>();

  constructor(readonly path: string) {
    for (const entry of readJsonl<CheckpointEntry>(path)) this.latest.set(entry.key, entry);
  }

  isDone(key: string) {
    return this.latest.get(key)?.status === "done";
  }

  record(entry: Omit<CheckpointEntry, "at">) {
    const full = { ...entry, at: new Date().toISOString() };
    append(this.path, full);
    this.latest.set(entry.key, full);
  }
}

export class Snapshots {
  constructor(readonly path: string) {}

  save(entry: Omit<SnapshotEntry, "at">) {
    append(this.path, { ...entry, at: new Date().toISOString() });
  }

  /** O primeiro snapshot de cada item é o estado original (antes de qualquer execução). */
  originals(): SnapshotEntry[] {
    const seen = new Map<string, SnapshotEntry>();
    for (const s of readJsonl<SnapshotEntry>(this.path)) if (!seen.has(s.key)) seen.set(s.key, s);
    return [...seen.values()];
  }
}

export function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
