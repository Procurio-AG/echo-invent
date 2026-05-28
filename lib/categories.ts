import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CategoryGroup = {
  parent: string;
  subcategories: string[];
};

type Loaded = {
  groups: CategoryGroup[];
  parentBySubcategory: Map<string, string>;
  allSubcategories: Set<string>;
};

let cache: Loaded | null = null;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function load(): Loaded {
  if (cache) return cache;

  const path = join(process.cwd(), "categories.csv");
  const text = readFileSync(path, "utf8");

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    cache = { groups: [], parentBySubcategory: new Map(), allSubcategories: new Set() };
    return cache;
  }

  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const parentIdx = header.indexOf("category");
  const subIdx = header.indexOf("subcategory");
  if (parentIdx === -1 || subIdx === -1) {
    throw new Error(
      "categories.csv must contain 'category' and 'subcategory' columns (got: " +
        header.join(", ") +
        ")"
    );
  }

  const parentBySubcategory = new Map<string, string>();
  const orderedParents: string[] = [];
  const subsByParent = new Map<string, string[]>();

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const parent = (fields[parentIdx] ?? "").trim();
    const sub = (fields[subIdx] ?? "").trim();
    if (!parent || !sub) continue;
    if (parentBySubcategory.has(sub)) continue;

    parentBySubcategory.set(sub, parent);
    if (!subsByParent.has(parent)) {
      subsByParent.set(parent, []);
      orderedParents.push(parent);
    }
    subsByParent.get(parent)!.push(sub);
  }

  const groups: CategoryGroup[] = orderedParents.map((parent) => ({
    parent,
    subcategories: subsByParent.get(parent)!,
  }));
  const allSubcategories = new Set(parentBySubcategory.keys());

  cache = { groups, parentBySubcategory, allSubcategories };
  return cache;
}

export function getCategoryGroups(): CategoryGroup[] {
  return load().groups;
}

export function isKnownSubcategory(sub: string): boolean {
  return load().allSubcategories.has(sub);
}

export function getParentOf(sub: string): string | undefined {
  return load().parentBySubcategory.get(sub);
}
