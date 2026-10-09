// Bench results viewer, a FullStacked project rooted at perfs/ so it can read
// the results under perfs/bench.
//
//   npm start -- fullstacked perfs

import "./viewer/style.css";
import { main } from "./viewer/main.ts";

document.documentElement.lang = "en";
document.title = "Bench Results";

document.body.innerHTML = `
    <header class="topbar">
        <div class="title">
            <h1>FullStacked bridge benchmarks</h1>
            <p class="subtitle" id="subtitle">Loading results…</p>
        </div>
        <button id="theme" class="ghost" type="button" title="Toggle theme">
            Theme
        </button>
    </header>

    <section class="filters" aria-label="Filters">
        <label>
            <span>Metric</span>
            <select id="metric"></select>
        </label>
        <label>
            <span>Scale</span>
            <select id="scale">
                <option value="absolute">Absolute values</option>
                <option value="relative">Speedup vs baseline (×)</option>
            </select>
        </label>
        <label>
            <span>Baseline</span>
            <select id="baseline"></select>
        </label>
        <label>
            <span>Compare</span>
            <select id="compare"></select>
        </label>
        <div class="legend" id="platforms" aria-label="Platforms"></div>
    </section>

    <section class="summary" id="summary" aria-label="Summary"></section>

    <section class="detail" id="detail" hidden>
        <div class="card">
            <div class="card-head">
                <div>
                    <h2 id="detail-title"></h2>
                    <p class="muted" id="detail-sub"></p>
                </div>
                <button id="detail-close" class="ghost" type="button">
                    Close
                </button>
            </div>
            <div class="chart large" id="detail-chart"></div>
            <div class="table-wrap">
                <table id="detail-table"></table>
            </div>
        </div>
    </section>

    <section class="grid" id="grid" aria-label="Benchmarks"></section>

    <div class="tooltip" id="tooltip" role="status" hidden></div>

    <p class="error" id="error" hidden></p>
`;

main();
