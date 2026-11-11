"use client";

import { useEffect, useMemo, useState } from "react";
import { hierarchy, partition } from "d3-hierarchy";
import { arc as d3Arc } from "d3-shape";
import { formatBytes } from "../lib/formatters";

const SIZE = 500;
const RADIUS = 230;
const MIN_ANGLE = 0.025;

export default function Sunburst({ data, onOpen }) {
  const [hoveredNode, setHoveredNode] = useState(null);

  const root = useMemo(() => {
    if (!data) return null;
    return hierarchy(data)
      .sum((item) => item.children?.length ? 0 : Number(item.size) || 0)
      .sort((a, b) => b.value - a.value);
  }, [data]);

  const nodes = useMemo(() => {
    if (!root) return [];
    partition().size([Math.PI * 2, RADIUS]).padding(0.015)(root);
    return root.descendants().filter((node) =>
      node.depth > 0 && node.depth <= 3 && node.x1 - node.x0 >= MIN_ANGLE,
    );
  }, [root]);

  const normalArc = useMemo(() => d3Arc()
    .startAngle((node) => node.x0 - Math.PI / 2)
    .endAngle((node) => node.x1 - Math.PI / 2)
    .innerRadius((node) => node.y0)
    .outerRadius((node) => Math.max(node.y1 - 2, node.y0 + 1)), []);

  const hoverArc = useMemo(() => d3Arc()
    .startAngle((node) => node.x0 - Math.PI / 2 - 0.006)
    .endAngle((node) => node.x1 - Math.PI / 2 + 0.006)
    .innerRadius((node) => Math.max(node.y0 - 3, 0))
    .outerRadius((node) => node.y1 + 7), []);

  useEffect(() => setHoveredNode(null), [data]);

  const displayNode = hoveredNode && nodes.includes(hoveredNode) ? hoveredNode : null;
  const orderedNodes = useMemo(() => [
    ...nodes.filter((node) => node !== displayNode),
    ...(displayNode ? [displayNode] : []),
  ], [nodes, displayNode]);

  function getColor(node) {
    let top = node;
    while (top.parent && top.parent.depth > 0) top = top.parent;
    const index = top.parent ? top.parent.children.indexOf(top) : 0;
    const hue = (index * 55) % 360;
    return `hsl(${hue}, 62%, ${42 + node.depth * 8}%)`;
  }

  if (!data || !root) {
    return <div className="dl-sunburst-loading">Loading visualization…</div>;
  }

  const displayName = displayNode?.data.name || data.name;
  const displaySize = displayNode?.data.size ?? data.size;
  const displayPercent = displayNode && data.size
    ? ((Number(displayNode.data.size) / Number(data.size)) * 100).toFixed(1)
    : null;

  return (
    <div className="dl-sunburst-canvas">
      <svg width="100%" height="100%" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Storage usage sunburst chart">
        <g transform={`translate(${SIZE / 2}, ${SIZE / 2})`}>
          {orderedNodes.map((node, index) => {
            const isHovered = node === displayNode;
            const clickable = node.data.type === "directory" || Boolean(node.data.id);
            return (
              <path
                key={`${node.data.path || node.data.name}-${node.depth}-${index}`}
                d={isHovered ? hoverArc(node) : normalArc(node)}
                fill={getColor(node)}
                stroke="var(--dl-surface)"
                strokeWidth={isHovered ? 2 : 1.5}
                opacity={displayNode && !isHovered ? 0.48 : 1}
                style={{ cursor: clickable ? "pointer" : "default" }}
                onMouseEnter={() => setHoveredNode(node)}
                onMouseLeave={() => setHoveredNode(null)}
                onClick={() => clickable && onOpen(node.data)}
                tabIndex={clickable ? 0 : -1}
                role={clickable ? "button" : undefined}
                onKeyDown={(event) => {
                  if (clickable && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    onOpen(node.data);
                  }
                }}
              >
                <title>{node.data.name} — {formatBytes(node.data.size)}</title>
              </path>
            );
          })}
          <circle cx="0" cy="0" r="75" fill="var(--dl-surface)" stroke="var(--dl-border)" />
          <text x="0" y="-20" textAnchor="middle" fill="var(--dl-text)" fontSize="15" fontWeight="700">
            {formatBytes(displaySize)}
          </text>
          <text x="0" y="2" textAnchor="middle" fill="var(--dl-muted)" fontSize="11">
            {String(displayName).length > 19 ? `${String(displayName).slice(0, 19)}…` : displayName}
          </text>
          <text x="0" y="22" textAnchor="middle" fill="var(--dl-muted-2)" fontSize="10">
            {displayPercent ? `${displayPercent}% of current` : "Current location"}
          </text>
        </g>
      </svg>
    </div>
  );
}
