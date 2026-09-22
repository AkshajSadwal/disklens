"use client";
import { useState } from "react";
import { hierarchy, partition } from "d3-hierarchy";
import { arc as d3Arc } from "d3-shape";
import { formatBytes } from "../lib/formatters";

export default function Sunburst({ data, onOpen }) {
  const size = 500;
  const radius = 230;

  const [hoveredNode, setHoveredNode] = useState(null);

  if (!data) {
    return (
      <div
        style={{
          width: size,
          height: size,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#8f98a8",
        }}
      >
        Loading visualization...
      </div>
    );
  }

  const root = hierarchy(data)
    .sum((d) => {
      if (d.children && d.children.length > 0) {
        return 0;
      }

      return Number(d.size) || 0;
    })
    .sort((a, b) => b.value - a.value);

  partition()
    .size([Math.PI * 2, radius])
    .padding(0.015)(root);

  const MIN_ANGLE = 0.025;

  const nodes = root
    .descendants()
    .filter(
      (node) =>
        node.depth > 0 && node.depth <= 3 && node.x1 - node.x0 >= MIN_ANGLE,
    );

  const normalArc = d3Arc()
    .startAngle((d) => d.x0 - Math.PI / 2)
    .endAngle((d) => d.x1 - Math.PI / 2)
    .innerRadius((d) => d.y0)
    .outerRadius((d) => Math.max(d.y1 - 2, d.y0 + 1));

  const hoverArc = d3Arc()
    .startAngle((d) => d.x0 - Math.PI / 2 - 0.006)
    .endAngle((d) => d.x1 - Math.PI / 2 + 0.006)
    .innerRadius((d) => Math.max(d.y0 - 3, 0))
    .outerRadius((d) => d.y1 + 7);

  function getColor(node) {
    let top = node;

    while (top.parent && top.parent.depth > 0) {
      top = top.parent;
    }

    const index = top.parent ? top.parent.children.indexOf(top) : 0;

    const hue = (index * 55) % 360;

    return `hsl(${hue}, 70%, ${42 + node.depth * 8}%)`;
  }

  const displayNode = hoveredNode || null;

  const displayName = displayNode ? displayNode.data.name : data.name;

  const displaySize = displayNode ? displayNode.data.size : data.size;

  const displayPercent =
    displayNode && data.size
      ? ((Number(displayNode.data.size) / Number(data.size)) * 100).toFixed(1)
      : null;

  // Draw normal nodes first and hovered node last.
  const orderedNodes = [
    ...nodes.filter((node) => node !== hoveredNode),
    ...(hoveredNode ? [hoveredNode] : []),
  ];

  return (
    <div
      style={{
        width: size,
        height: size,
        position: "relative",
      }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`translate(${size / 2}, ${size / 2})`}>
          {orderedNodes.map((node, index) => {
            const isHovered = node === hoveredNode;

            const clickable =
              node.data.type === "directory" || Boolean(node.data.id);

            const path = isHovered ? hoverArc(node) : normalArc(node);

            return (
              <path
                key={`${node.data.path || node.data.name}-${node.depth}-${index}`}
                d={path}
                fill={getColor(node)}
                stroke="#ffffff"
                strokeWidth={isHovered ? 2 : 1.5}
                opacity={hoveredNode && !isHovered ? 0.45 : 1}
                style={{
                  cursor: clickable ? "pointer" : "default",
                  transition: "opacity 0.15s",
                }}
                onMouseEnter={() => {
                  setHoveredNode(node);
                }}
                onMouseLeave={() => {
                  setHoveredNode(null);
                }}
                onClick={() => {
                  if (!clickable) return;

                  onOpen(node.data);
                }}
              >
                <title>
                  {node.data.name} — {formatBytes(node.data.size)}
                </title>
              </path>
            );
          })}

          {/* Center */}
          <circle cx="0" cy="0" r="75" fill="#ffffff" stroke="#dbe3ec" />

          <text
            x="0"
            y="-20"
            textAnchor="middle"
            fill="#0f172a"
            fontSize="15"
            fontWeight="bold"
          >
            {formatBytes(displaySize)}
          </text>

          <text x="0" y="2" textAnchor="middle" fill="#475569" fontSize="11">
            {displayName.length > 19
              ? `${displayName.slice(0, 19)}...`
              : displayName}
          </text>

          <text x="0" y="22" textAnchor="middle" fill="#94a3b8" fontSize="10">
            {displayPercent
              ? `${displayPercent}% of current`
              : "Current location"}
          </text>
        </g>
      </svg>
    </div>
  );
}
