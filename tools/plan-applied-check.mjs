#!/usr/bin/env bun
// APPLIED 계획 id와 실제 레코드 id를 읽기 전용으로 대조한다.
// 건수와 id만 출력한다. 금액과 고객명은 출력하지 않는다.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function idsFrom(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string" && item.length > 0) return [item];
      if (item && typeof item === "object" && typeof item.id === "string" && item.id.length > 0) return [item.id];
      return [];
    });
  }
  if (value && typeof value === "object") {
    for (const key of ["ids", "items", "applied", "records"]) {
      if (key in value) return idsFrom(value[key]);
    }
  }
  return null;
}

function readJson(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const ids = idsFrom(parsed);
  if (!ids) throw new Error("id list required");
  return ids;
}

function readQuery(command) {
  const [bin, ...args] = command;
  if (!bin) throw new Error("query command required");
  const result = spawnSync(bin, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error("query failed");
  const text = result.stdout.trim();
  if (!text) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    const ids = idsFrom(JSON.parse(text));
    if (!ids) throw new Error("id list required");
    return ids;
  }
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

const args = process.argv.slice(2);
let planPath = "";
let recordsPath = "";
const query = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--plan") planPath = args[++i] ?? "";
  else if (args[i] === "--records") recordsPath = args[++i] ?? "";
  else if (args[i] === "--query") query.push(...args.slice(i + 1).filter((item, index) => !(index === 0 && item === "--")));
  else throw new Error("usage: plan-applied-check.mjs --plan file (--records file | --query command)");
  if (args[i] === "--query") break;
}
if (!planPath || Boolean(recordsPath) === query.length > 0) {
  throw new Error("usage: plan-applied-check.mjs --plan file (--records file | --query command)");
}

const planned = [...new Set(readJson(planPath))];
const actual = [...new Set(recordsPath ? readJson(recordsPath) : readQuery(query))];
const actualSet = new Set(actual);
const present = planned.filter((id) => actualSet.has(id));
const missing = planned.filter((id) => !actualSet.has(id));
const plannedSet = new Set(planned);
const isolated = actual.filter((id) => !plannedSet.has(id));

process.stdout.write(`계획 ${planned.length}\n있음 ${present.length}\n없음 ${missing.length}\n격리 ${isolated.length}\n`);
for (const id of missing) process.stdout.write(`없음 ${id}\n`);
for (const id of isolated) process.stdout.write(`격리 ${id}\n`);
process.exit(missing.length === 0 && isolated.length === 0 ? 0 : 2);
