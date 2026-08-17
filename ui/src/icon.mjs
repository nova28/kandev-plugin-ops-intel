/**
 * The plugin's own nav glyph — a gauge.
 *
 * WHY NOT A CURATED NAME. `icon: "chart"` resolved to Tabler's `IconChartBar`, which is the
 * glyph the host's own **Stats** button already uses — and since this item moved into the
 * sidebar footer, the two sat side by side as identical bar charts. An icon that duplicates its
 * neighbour is worse than no icon: it reads as a rendering bug, and neither button says which
 * one you want. None of the 18 curated names is right either (bell, bolt, book, bug, calendar,
 * chart, checklist, cloud, database, flask, globe, message, puzzle, robot, rocket, settings,
 * ticket, users), so this takes the contract's other option: a plugin-owned component.
 *
 * WHY A GAUGE. The surface is not only about money. It answers how the operation is running —
 * spend per model and per step, agent time against idle time, tool mix, how long steps spend
 * waiting, code output per dollar, anomalies. A coin or a receipt would name the narrowest
 * reading of that and would date badly as the plugin grows; a dial reads as "rate and health of
 * a running thing", which is the whole surface.
 *
 * DRAWN FOR 14 PIXELS. The footer renders icons at `h-3.5 w-3.5`, so this is three strokes and
 * nothing else: the dial, the needle, the hub. Tabler's conventions are matched deliberately
 * (24 viewBox, `currentColor`, no fill, 2px round-capped strokes) so it sits in the row as a
 * peer rather than as a foreign asset. The host sizes it through `className`, which wins over
 * the width/height attributes, so those stay as the natural size for any surface that does not
 * pass one.
 */

export function createGaugeIcon(host) {
  var jsx = host.jsx;

  return function OpsGaugeIcon(props) {
    var p = props || {};
    return jsx(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        width: 24,
        height: 24,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className: p.className,
        // The label lives on the button, so the glyph must not be announced twice.
        "aria-hidden": p["aria-hidden"] == null ? "true" : p["aria-hidden"],
      },
      // The dial: a half turn, open at the bottom where a gauge's scale ends.
      jsx("path", { d: "M4 15a8 8 0 0 1 16 0" }),
      // The needle, deliberately off-centre. A needle straight up reads as a decoration; one
      // swung to a value reads as a measurement.
      jsx("path", { d: "M12 15l3.6-4.2" }),
      // The hub, which is what stops the two paths looking like an unrelated arc and slash.
      jsx("circle", { cx: 12, cy: 15, r: 1.2 })
    );
  };
}
