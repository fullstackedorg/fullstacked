// Bench results viewer. Runs as a FullStacked project rooted at perfs/
// (`npm start -- fullstacked perfs`) and reads the results from perfs/bench with fs.

import fs from "node:fs";

type Platform = { id: string; label: string };

type Metric = {
    label: string;
    unit?: string;
    higher?: boolean;
};

type Stage = {
    id: string;
    stage: string;
    commit: string;
    files: string[];
    order: number;
};

type BenchResult = { name: string; suite: string; [key: string]: unknown };

type BenchFile = { results?: BenchResult[] };

type Benchmark = { name: string; suite: string; metrics: Set<string> };

type Series = {
    platform: Platform;
    slot: number;
    values: (number | null)[];
    plot: (number | null)[];
};

const benchDirectory = "/bench";

const PLATFORMS: Platform[] = [
    { id: "apple-macos", label: "macOS" },
    { id: "apple-ios", label: "iOS" },
    { id: "android", label: "Android" },
    { id: "windows", label: "Windows" },
    { id: "linux-gtk", label: "Linux GTK" },
    { id: "linux-qt", label: "Linux Qt" },
    { id: "node", label: "Node" }
];

const METRICS: Record<string, Metric> = {
    auto: { label: "Auto (ops/s, MB/s for streams)" },
    opsPerSec: { label: "Throughput (ops/s)", unit: "ops/s", higher: true },
    mbPerSec: { label: "Throughput (MB/s)", unit: "MB/s", higher: true },
    chunksPerSec: {
        label: "Chunks per second",
        unit: "chunks/s",
        higher: true
    },
    meanMs: { label: "Mean latency (ms)", unit: "ms", higher: false },
    p95Ms: { label: "p95 latency (ms)", unit: "ms", higher: false },
    durationMs: { label: "Duration (ms)", unit: "ms", higher: false }
};

const AUTO_METRIC: Record<string, string> = { stream: "mbPerSec" };

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
const el = (
    tag: string,
    attrs: Record<string, any> = {},
    children: (Node | string | null) | (Node | string | null)[] = []
) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (k === "style") node.style.cssText = v;
        else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
    }
    for (const child of [].concat(children)) {
        if (child == null) continue;
        node.append(
            typeof child === "string" ? document.createTextNode(child) : child
        );
    }
    return node;
};
const svgEl = (tag: string, attrs: Record<string, string | number> = {}) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
};

const state = {
    stages: [] as Stage[],
    data: {} as Record<string, Record<string, BenchFile>>, // data[stageId][platformId]
    benchmarks: [] as Benchmark[],
    metric: "auto",
    scale: "absolute", // absolute | relative (× vs baseline stage)
    baseline: null as string | null,
    compare: null as string | null,
    enabled: new Set(PLATFORMS.map((p) => p.id)),
    detail: null as Benchmark | null
};

// ---------- loading ----------

// stages and platform files under perfs/bench
async function benchIndex(): Promise<Stage[]> {
    const entries = await fs.promises.readdir(benchDirectory, {
        withFileTypes: true
    });
    const stages = await Promise.all(
        entries
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
                const [stage, commit] = entry.name.split("-");
                const files = (
                    await fs.promises.readdir(`${benchDirectory}/${entry.name}`)
                )
                    .filter((file) => file.endsWith(".json"))
                    .sort();
                return {
                    id: entry.name,
                    stage,
                    commit: commit ?? "",
                    files,
                    order: parseInt(stage.replace(/\D/g, "")) || 0
                };
            })
    );
    return stages
        .filter((stage) => stage.files.length > 0)
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

async function load() {
    state.stages = await benchIndex();

    await Promise.all(
        state.stages.map(async (stage) => {
            state.data[stage.id] = {};
            await Promise.all(
                stage.files.map(async (file) => {
                    const platform = file.replace(/\.json$/, "");
                    try {
                        state.data[stage.id][platform] = await readJson(
                            `${benchDirectory}/${stage.id}/${file}`
                        );
                    } catch (e) {
                        console.warn(`skipping ${stage.id}/${file}: ${e}`);
                    }
                })
            );
        })
    );

    const seen = new Map<string, Benchmark>();
    for (const stage of state.stages) {
        for (const json of Object.values(state.data[stage.id])) {
            for (const r of json.results ?? []) {
                if (!seen.has(r.name)) {
                    seen.set(r.name, {
                        name: r.name,
                        suite: r.suite,
                        metrics: new Set()
                    });
                }
                for (const key of Object.keys(r)) {
                    if (METRICS[key]) seen.get(r.name).metrics.add(key);
                }
            }
        }
    }
    state.benchmarks = [...seen.values()];
    state.baseline = state.stages[0]?.id ?? null;
    state.compare = state.stages[state.stages.length - 1]?.id ?? null;
}

async function readJson(file: string) {
    return JSON.parse(
        await fs.promises.readFile(file, { encoding: "utf8" })
    ) as BenchFile;
}

// ---------- data access ----------

function metricFor(benchmark: Benchmark) {
    if (state.metric !== "auto") return state.metric;
    return AUTO_METRIC[benchmark.suite] ?? "opsPerSec";
}

function value(
    stageId: string,
    platformId: string,
    benchmarkName: string,
    metric: string
) {
    const json = state.data[stageId]?.[platformId];
    const r = json?.results?.find((r) => r.name === benchmarkName);
    const v = r?.[metric];
    return typeof v === "number" ? v : null;
}

function seriesFor(benchmark: Benchmark, metric: string): Series[] {
    const baseIndex = state.stages.findIndex((s) => s.id === state.baseline);
    return PLATFORMS.filter((p) => state.enabled.has(p.id)).map((p) => {
        const values = state.stages.map((s) =>
            value(s.id, p.id, benchmark.name, metric)
        );
        // relative: improvement over the baseline stage, > 1 is always better
        const plot =
            state.scale === "relative"
                ? values.map((v) => improvement(values[baseIndex], v, metric))
                : values;
        return { platform: p, slot: PLATFORMS.indexOf(p) + 1, values, plot };
    });
}

// ratio > 1 means compare is better than baseline, whatever the metric direction
function improvement(
    baselineValue: number | null,
    compareValue: number | null,
    metric: string
) {
    if (baselineValue == null || compareValue == null) return null;
    if (baselineValue === 0 || compareValue === 0) return null;
    return METRICS[metric].higher
        ? compareValue / baselineValue
        : baselineValue / compareValue;
}

// ---------- formatting ----------

function fmt(v: number | null, unit: string) {
    if (v == null) return "–";
    if (unit === "ms")
        return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    if (v >= 10000) return (v / 1000).toFixed(1) + "K";
    if (v >= 1000)
        return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (v >= 100) return v.toFixed(0);
    return v.toFixed(1);
}

function fmtTick(v: number, unit: string) {
    if (state.scale === "relative") return `${+v.toFixed(2)}×`;
    if (unit === "ms") return fmt(v, unit);
    if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + "K";
    return String(v);
}

function fmtDelta(ratio: number | null) {
    if (ratio == null) return "–";
    const pct = (ratio - 1) * 100;
    const sign = pct > 0 ? "+" : "";
    return `${sign}${pct.toFixed(pct > 100 || pct < -100 ? 0 : 1)}%`;
}

function deltaClass(ratio: number | null) {
    if (ratio == null) return "delta";
    if (ratio > 1.02) return "delta up";
    if (ratio < 0.98) return "delta down";
    return "delta";
}

function stageLabel(stage: Stage) {
    return stage.stage;
}

// round tick step (1, 2, 2.5, 5 × 10^n) giving about `count` ticks up to max
function niceTicks(max: number, count = 4) {
    if (!(max > 0)) max = 1;
    const raw = max / count;
    const exp = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / exp;
    const step =
        (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
    const top = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let v = step; v <= top + step / 2; v += step) ticks.push(v);
    return { max: top, ticks };
}

// ---------- line chart ----------

function renderLineChart(
    container: HTMLElement,
    benchmark: Benchmark,
    metric: string,
    large: boolean
) {
    container.replaceChildren();
    const series = seriesFor(benchmark, metric);
    const unit = METRICS[metric].unit;
    const all = series.flatMap((s) => s.plot).filter((v) => v != null);
    if (all.length === 0 || state.stages.length === 0) {
        container.append(
            el("div", { class: "empty" }, "no data for this metric")
        );
        return;
    }

    const width = container.clientWidth || 300;
    const height = container.clientHeight || 180;
    const pad = { top: 12, right: 16, bottom: 22, left: large ? 48 : 40 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const scale = niceTicks(Math.max(...all));
    const yMax = scale.max;
    const n = state.stages.length;
    const x = (i: number) =>
        pad.left + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
    const y = (v: number) => pad.top + plotH - (v / yMax) * plotH;

    const svg = svgEl("svg", {
        viewBox: `0 0 ${width} ${height}`,
        role: "img",
        "aria-label": `${benchmark.name}, ${METRICS[metric].label} per stage`
    });

    for (const v of scale.ticks) {
        svg.append(
            svgEl("line", {
                class: "gridline",
                x1: pad.left,
                x2: width - pad.right,
                y1: y(v),
                y2: y(v)
            })
        );
        const label = svgEl("text", {
            class: "tick",
            x: pad.left - 6,
            y: y(v) + 3,
            "text-anchor": "end"
        });
        label.textContent = fmtTick(v, unit);
        svg.append(label);
    }
    svg.append(
        svgEl("line", {
            class: "baseline",
            x1: pad.left,
            x2: width - pad.right,
            y1: y(0),
            y2: y(0)
        })
    );
    if (state.scale === "relative") {
        svg.append(
            svgEl("line", {
                class: "reference",
                x1: pad.left,
                x2: width - pad.right,
                y1: y(1),
                y2: y(1)
            })
        );
    }
    state.stages.forEach((s, i) => {
        const label = svgEl("text", {
            class: "tick",
            x: x(i),
            y: height - 6,
            "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle"
        });
        label.textContent = stageLabel(s);
        svg.append(label);
    });

    for (const s of series) {
        const color = `var(--s${s.slot})`;
        let d = "";
        let pen = false;
        s.plot.forEach((v, i) => {
            if (v == null) {
                pen = false;
                return;
            }
            d += `${pen ? "L" : "M"}${x(i)},${y(v)}`;
            pen = true;
        });
        svg.append(svgEl("path", { class: "series", d, stroke: color }));
        s.plot.forEach((v, i) => {
            if (v == null) return;
            svg.append(
                svgEl("circle", {
                    class: "dot",
                    cx: x(i),
                    cy: y(v),
                    r: 4,
                    fill: color
                })
            );
        });
    }

    const crosshair = svgEl("line", {
        class: "crosshair",
        x1: 0,
        x2: 0,
        y1: pad.top,
        y2: pad.top + plotH,
        visibility: "hidden"
    });
    svg.append(crosshair);

    const hit = svgEl("rect", {
        class: "hit",
        x: pad.left - 12,
        y: 0,
        width: plotW + 24,
        height
    });
    hit.addEventListener("pointermove", (e) => {
        const rect = svg.getBoundingClientRect();
        const px = ((e.clientX - rect.left) / rect.width) * width;
        let best = 0;
        for (let i = 1; i < n; i++) {
            if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
        }
        crosshair.setAttribute("x1", String(x(best)));
        crosshair.setAttribute("x2", String(x(best)));
        crosshair.setAttribute("visibility", "visible");
        showTooltip(e, benchmark, metric, series, best);
    });
    hit.addEventListener("pointerleave", () => {
        crosshair.setAttribute("visibility", "hidden");
        hideTooltip();
    });
    svg.append(hit);
    container.append(svg);
}

// ---------- tooltip ----------

function showTooltip(
    e: PointerEvent,
    benchmark: Benchmark,
    metric: string,
    series: Series[],
    stageIndex: number
) {
    const tip = $("tooltip");
    const stage = state.stages[stageIndex];
    const unit = METRICS[metric].unit;
    const baseIndex = state.stages.findIndex((s) => s.id === state.baseline);
    tip.replaceChildren(
        el("div", { class: "tt-title" }, `${benchmark.name} · ${stage.id}`)
    );
    for (const s of series) {
        const v = s.values[stageIndex];
        const ratio =
            baseIndex >= 0 && baseIndex !== stageIndex
                ? improvement(s.values[baseIndex], v, metric)
                : null;
        tip.append(
            el("div", { class: "tt-row" }, [
                el("span", { class: "key", style: `--c: var(--s${s.slot})` }),
                el("span", { class: "name" }, s.platform.label),
                el("span", { class: "val" }, [
                    `${fmt(v, unit)} ${v == null ? "" : unit}`,
                    ratio == null
                        ? null
                        : el(
                              "span",
                              { class: ` ${deltaClass(ratio)}` },
                              ` ${fmtDelta(ratio)}`
                          )
                ])
            ])
        );
    }
    tip.hidden = false;
    const margin = 12;
    let left = e.clientX + margin;
    let top = e.clientY + margin;
    const { width, height } = tip.getBoundingClientRect();
    if (left + width > window.innerWidth - margin)
        left = e.clientX - width - margin;
    if (top + height > window.innerHeight - margin)
        top = e.clientY - height - margin;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
}

function hideTooltip() {
    $("tooltip").hidden = true;
}

// ---------- views ----------

function renderFilters() {
    const metric = $<HTMLSelectElement>("metric");
    metric.replaceChildren(
        ...Object.entries(METRICS).map(([id, m]) =>
            el("option", { value: id }, m.label)
        )
    );
    metric.value = state.metric;
    $<HTMLSelectElement>("scale").value = state.scale;

    for (const id of ["baseline", "compare"] as const) {
        const select = $<HTMLSelectElement>(id);
        select.replaceChildren(
            ...state.stages.map((s) => el("option", { value: s.id }, s.id))
        );
        select.value = state[id];
    }

    $("platforms").replaceChildren(
        ...PLATFORMS.map((p, i) =>
            el(
                "button",
                {
                    type: "button",
                    "aria-pressed": String(state.enabled.has(p.id)),
                    style: `--c: var(--s${i + 1})`,
                    onclick: () => {
                        if (state.enabled.has(p.id)) state.enabled.delete(p.id);
                        else state.enabled.add(p.id);
                        renderFilters();
                        renderAll();
                    }
                },
                [el("span", { class: "key" }), p.label]
            )
        )
    );
}

function renderSummary() {
    const root = $("summary");
    root.replaceChildren();
    if (!state.baseline || !state.compare || state.baseline === state.compare)
        return;
    for (const p of PLATFORMS) {
        if (!state.enabled.has(p.id)) continue;
        const ratios = [];
        for (const b of state.benchmarks) {
            const metric = metricFor(b);
            if (!b.metrics.has(metric)) continue;
            const r = improvement(
                value(state.baseline, p.id, b.name, metric),
                value(state.compare, p.id, b.name, metric),
                metric
            );
            if (r != null) ratios.push(r);
        }
        if (ratios.length === 0) continue;
        const geo = Math.exp(
            ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length
        );
        root.append(
            el("div", { class: "tile" }, [
                el("div", { class: "label" }, [
                    el("span", {
                        class: "key",
                        style: `--c: var(--s${PLATFORMS.indexOf(p) + 1})`
                    }),
                    p.label
                ]),
                el("div", { class: "value" }, `${geo.toFixed(2)}×`),
                el(
                    "div",
                    { class: deltaClass(geo) },
                    `${fmtDelta(geo)} · geomean of ${ratios.length} benchmarks`
                )
            ])
        );
    }
    if (root.children.length) {
        root.prepend(
            el(
                "p",
                { class: "caption" },
                `Speedup of ${state.compare} over ${state.baseline}, geometric mean across benchmarks. Above 1× is faster for every metric.`
            )
        );
    }
}

function renderGrid() {
    const grid = $("grid");
    grid.replaceChildren();
    for (const b of state.benchmarks) {
        const metric = metricFor(b);
        if (!b.metrics.has(metric)) continue;
        const chart = el("div", { class: "chart" });
        const card = el(
            "div",
            {
                class: "card",
                role: "button",
                tabindex: "0",
                onclick: () => openDetail(b),
                onkeydown: (e: KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openDetail(b);
                    }
                }
            },
            [
                el("div", { class: "card-head" }, [
                    el("h2", {}, b.name),
                    el("span", { class: "hint" }, METRICS[metric].unit)
                ]),
                chart
            ]
        );
        grid.append(card);
        renderLineChart(chart, b, metric, false);
    }
}

function openDetail(benchmark: Benchmark) {
    state.detail = benchmark;
    renderDetail();
    $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDetail() {
    const section = $("detail");
    const b = state.detail;
    if (!b) {
        section.hidden = true;
        return;
    }
    const metric = metricFor(b);
    const unit = METRICS[metric].unit;
    section.hidden = false;
    $("detail-title").textContent = b.name;
    $("detail-sub").textContent = `${METRICS[metric].label} · ${
        METRICS[metric].higher ? "higher" : "lower"
    } is better · Δ compares ${state.compare} to ${state.baseline}`;

    const chart = $("detail-chart");
    renderLineChart(chart, b, metric, true);

    const table = $("detail-table");
    table.replaceChildren();
    const head = el("tr", {}, [
        el("th", {}, "Platform"),
        ...state.stages.map((s) => el("th", { title: s.commit }, s.id)),
        el("th", {}, "Δ")
    ]);
    table.append(el("thead", {}, head));
    const body = el("tbody");
    const baseIndex = state.stages.findIndex((s) => s.id === state.baseline);
    const cmpIndex = state.stages.findIndex((s) => s.id === state.compare);
    for (const s of seriesFor(b, metric)) {
        const ratio =
            baseIndex >= 0 && cmpIndex >= 0
                ? improvement(s.values[baseIndex], s.values[cmpIndex], metric)
                : null;
        body.append(
            el("tr", {}, [
                el("td", {}, [
                    el("span", {
                        class: "key",
                        style: `--c: var(--s${s.slot})`
                    }),
                    s.platform.label
                ]),
                ...s.values.map((v) => el("td", {}, fmt(v, unit))),
                el("td", { class: deltaClass(ratio) }, fmtDelta(ratio))
            ])
        );
    }
    table.append(body);
}

function renderAll() {
    renderSummary();
    renderDetail();
    renderGrid();
}

// ---------- boot ----------

function initTheme() {
    try {
        const saved = localStorage.getItem("bench-theme");
        if (saved) document.documentElement.dataset.theme = saved;
    } catch {}
    $("theme").addEventListener("click", () => {
        const dark =
            document.documentElement.dataset.theme === "dark" ||
            (!document.documentElement.dataset.theme &&
                matchMedia("(prefers-color-scheme: dark)").matches);
        const next = dark ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        try {
            localStorage.setItem("bench-theme", next);
        } catch {}
    });
}

export async function main() {
    initTheme();
    try {
        await load();
    } catch (e) {
        $("subtitle").textContent = "Could not load results.";
        const err = $("error");
        err.textContent = `${(e as Error).message}\n\nRun this project from the repository root with:  npm start -- fullstacked perfs`;
        err.hidden = false;
        return;
    }
    const files = state.stages.reduce((n, s) => n + s.files.length, 0);
    $("subtitle").textContent =
        `${state.stages.length} stages · ${files} result files · ${state.benchmarks.length} benchmarks`;

    renderFilters();
    $("metric").addEventListener("change", (e) => {
        state.metric = (e.target as HTMLSelectElement).value;
        renderAll();
    });
    $("scale").addEventListener("change", (e) => {
        state.scale = (e.target as HTMLSelectElement).value;
        renderAll();
    });
    $("baseline").addEventListener("change", (e) => {
        state.baseline = (e.target as HTMLSelectElement).value;
        renderAll();
    });
    $("compare").addEventListener("change", (e) => {
        state.compare = (e.target as HTMLSelectElement).value;
        renderAll();
    });
    $("detail-close").addEventListener("click", () => {
        state.detail = null;
        renderDetail();
    });

    let resizeTimer: ReturnType<typeof setTimeout>;
    window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            renderGrid();
            renderDetail();
        }, 100);
    });

    renderAll();
}
