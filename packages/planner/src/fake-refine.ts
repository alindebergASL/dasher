/**
 * How the deterministic planner edits a plan: applying a reader's change
 * request, and repairing the findings that rejected an attempt.
 */
import type { PlanFinding } from "./plan";
import {
  chooseRoles,
  defaultPlan,
  filterValues,
  matchValues,
  readFilters,
  readGrain,
  readLastPeriods,
  supported,
  type TableSummary,
} from "./fake-heuristics";
import {
  TABLE_SECTION_KINDS,
  type TablePlan,
  type TableSectionKind,
} from "./table-plan";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Page = TablePlan["pages"][number];

const SECTION_WORDS: ReadonlyArray<[RegExp, TableSectionKind]> = [
  [/\bsummary\b/iu, "summary"],
  [/\b(?:headline|totals?|metrics?|kpis?)\b/iu, "headline-totals"],
  [/\b(?:categor(?:y|ies)|breakdown|ranking)\b/iu, "by-category"],
  [/\b(?:movers?|changes?|what moved)\b/iu, "movers"],
  [/\b(?:trend|over time|chart|series)\b/iu, "trend"],
  [/\b(?:largest|biggest|top)\b/iu, "largest-rows"],
  [/\b(?:budget|variance)\b/iu, "budget-variance"],
  [/\b(?:table|rows|raw|detail lines)\b/iu, "table"],
];

function namedSections(text: string): TableSectionKind[] {
  const found = SECTION_WORDS.filter(([pattern]) => pattern.test(text)).map(
    ([, kind]) => kind,
  );
  for (const kind of TABLE_SECTION_KINDS) {
    if (text.toLowerCase().includes(kind) && !found.includes(kind))
      found.push(kind);
  }
  return found;
}

function clone(plan: TablePlan): Mutable<TablePlan> {
  return JSON.parse(JSON.stringify(plan)) as Mutable<TablePlan>;
}

function replaceMeasureName(
  text: string,
  previous: string,
  next: string,
): string {
  const at = text
    .toLocaleLowerCase("en-US")
    .indexOf(previous.toLocaleLowerCase("en-US"));
  if (at < 0) return text;
  return `${text.slice(0, at)}${next}${text.slice(at + previous.length)}`;
}

function dropSections(
  pages: Page[],
  kinds: readonly TableSectionKind[],
): Page[] {
  return pages
    .map((page) => ({
      ...page,
      sections: page.sections.filter((section) => !kinds.includes(section)),
    }))
    .filter((page) => page.sections.length > 0);
}

function addSections(
  pages: Page[],
  kinds: readonly TableSectionKind[],
): Page[] {
  const present = new Set(pages.flatMap((page) => page.sections));
  const next = pages.map((page) => ({ ...page, sections: [...page.sections] }));
  for (const kind of kinds) {
    if (present.has(kind)) continue;
    const room = next.find((page) => page.sections.length < 6);
    if (room !== undefined) {
      room.sections.push(kind);
    } else if (next.length < 3) {
      next.push({
        id: `more-${String(next.length + 1)}`,
        title: "More",
        description: "Sections added on request.",
        sections: [kind],
      });
    }
    present.add(kind);
  }
  return next;
}

/** Applies one change request; an instruction nothing recognises returns the plan unchanged. */
export function applyRefinement(
  previous: TablePlan,
  instruction: string,
  table: TableSummary,
): TablePlan {
  const plan = clone(previous);
  const text = instruction.trim();
  let changed = false;

  const requestedPrimaryMeasure =
    /\b(?:use|read|treat)\s+(.+?)\s+as\s+(?:the\s+)?(?:primary\s+)?(?:amount|measure|metric)\b/iu.exec(
      text,
    )?.[1];
  if (requestedPrimaryMeasure !== undefined) {
    const requested = requestedPrimaryMeasure.trim().toLocaleLowerCase("en-US");
    const measure = table.columns.find(
      (column) =>
        column.semanticKind === "measure" &&
        column.name.toLocaleLowerCase("en-US") === requested,
    );
    if (measure !== undefined && measure.name !== plan.roles.amount) {
      const previous = plan.roles.amount;
      plan.roles = { ...plan.roles, amount: measure.name };
      plan.title = replaceMeasureName(plan.title, previous, measure.name);
      plan.framing = replaceMeasureName(plan.framing, previous, measure.name);
      plan.pages = plan.pages.map((page) => ({
        ...page,
        title: replaceMeasureName(page.title, previous, measure.name),
        description: replaceMeasureName(
          page.description,
          previous,
          measure.name,
        ),
      }));
      changed = true;
    }
  }

  if (/\b(?:just|only) the overview\b|\bshorter\b|\bone page\b/iu.test(text)) {
    if (plan.pages.length > 1) {
      plan.pages = [plan.pages[0] as Page];
      changed = true;
    }
  }

  const category = table.columns.find(
    (column) => column.name === plan.roles.category,
  );
  const values = filterValues(table, category);

  const drop =
    /\b(?:drop|remove|hide|delete|without the|no more)\b(.*)$/iu.exec(text);
  // RULE: a drop phrase naming a category value filters that value out; only a
  // phrase that names no value removes the section it names.
  if (drop !== null && matchValues(drop[1] as string, values).length === 0) {
    const kinds = namedSections(drop[1] as string);
    const pages = dropSections(plan.pages, kinds);
    if (kinds.length > 0 && pages.length > 0) {
      plan.pages = pages;
      changed = true;
    }
  }

  const add = /\b(?:add|include|show|bring back)\b(.*)$/iu.exec(text);
  if (add !== null) {
    const kinds = supported(namedSections(add[1] as string), plan.roles);
    const pages = addSections(plan.pages, kinds);
    if (JSON.stringify(pages) !== JSON.stringify(plan.pages)) {
      plan.pages = pages;
      changed = true;
    }
  }

  const filters = readFilters(text, category, values);
  if (filters.length > 0) {
    const kept = plan.filters.filter(
      (filter) =>
        !filters.some(
          (next) => next.column === filter.column && next.op === filter.op,
        ),
    );
    plan.filters = [...kept, ...filters].slice(0, 8);
    changed = true;
  }

  const grain = readGrain(text);
  if (grain !== undefined && grain !== plan.grain) {
    plan.grain = grain;
    changed = true;
  }

  const last = readLastPeriods(text);
  if (last !== undefined && last.count !== plan.lastPeriods) {
    plan.lastPeriods = last.count;
    changed = true;
  }

  return changed ? plan : previous;
}

function pathIndexes(path: string): number[] {
  return [...path.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1]));
}

/** Repairs each finding mechanically; anything unrepairable falls back to a fresh default plan. */
export function applyRevision(
  previous: TablePlan,
  findings: readonly PlanFinding[],
  table: TableSummary,
): TablePlan {
  const plan = clone(previous);
  const roles = plan.roles as Mutable<TablePlan["roles"]>;
  const fresh = chooseRoles(table);
  const sectionsToDrop = new Set<string>();
  const filtersToDrop = new Set<number>();

  for (const finding of findings) {
    const indexes = pathIndexes(finding.path);
    switch (finding.code) {
      case "unknown_column":
      case "role_type": {
        const role = /^roles\.(\w+)$/u.exec(finding.path)?.[1] as
          keyof TablePlan["roles"] | undefined;
        if (role === "amount") roles.amount = fresh.amount;
        else if (role !== undefined) {
          if (fresh[role] !== undefined) roles[role] = fresh[role];
          else delete roles[role];
        } else if (
          finding.path.startsWith("filters[") &&
          indexes[0] !== undefined
        ) {
          filtersToDrop.add(indexes[0]);
        }
        break;
      }
      case "section_needs_role":
      case "duplicate_section":
        sectionsToDrop.add(finding.path);
        break;
      case "duplicate_page_id": {
        const page = plan.pages[indexes[0] ?? -1];
        if (page !== undefined)
          page.id = `${page.id}-${String((indexes[0] ?? 0) + 1)}`;
        break;
      }
      case "free_text_measurement": {
        const replacement = defaultPlan("", "", roles, table);
        if (finding.path === "title") plan.title = replacement.title;
        else if (finding.path === "audience")
          plan.audience = replacement.audience;
        else if (finding.path === "framing") plan.framing = replacement.framing;
        else {
          const page = plan.pages[indexes[0] ?? -1];
          if (page !== undefined) {
            if (finding.path.endsWith(".title"))
              page.title = `Page ${String((indexes[0] ?? 0) + 1)}`;
            else page.description = "Composed from the file's own figures.";
          }
        }
        break;
      }
      case "empty_sections":
        plan.filters = [];
        delete plan.lastPeriods;
        break;
      case "plan_malformed":
      case "spec_rejected":
        return defaultPlan("", "", fresh, table);
    }
  }

  plan.filters = plan.filters.filter((_, index) => !filtersToDrop.has(index));
  plan.pages = plan.pages
    .map((page, pageIndex) => ({
      ...page,
      sections: page.sections.filter(
        (_, sectionIndex) =>
          !sectionsToDrop.has(`pages[${pageIndex}].sections[${sectionIndex}]`),
      ),
    }))
    .filter((page) => page.sections.length > 0);
  // Roles may have changed under the sections; keep only what they still support.
  plan.pages = plan.pages
    .map((page) => ({ ...page, sections: supported(page.sections, roles) }))
    .filter((page) => page.sections.length > 0);
  if (plan.pages.length === 0) return defaultPlan("", "", fresh, table);
  return plan;
}
