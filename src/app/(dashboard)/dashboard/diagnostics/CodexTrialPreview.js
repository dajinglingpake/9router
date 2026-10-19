"use client";

import { useEffect, useRef, useState } from "react";

export default function CodexTrialPreview({ src, title, className = "" }) {
  const container = useRef(null);
  const frame = useRef(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 1280, height: 800 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setBounds({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(container.current);
    const onMessage = event => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== "9router-codex-preview-size") return;
      const { width, height } = event.data;
      if (![width, height].every(value => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 32768)) return;
      setViewport(previous => {
        const next = { width: Math.max(previous.width, Math.ceil(width)), height: Math.max(previous.height, Math.ceil(height)) };
        return next.width === previous.width && next.height === previous.height ? previous : next;
      });
    };
    window.addEventListener("message", onMessage);
    return () => { observer.disconnect(); window.removeEventListener("message", onMessage); };
  }, []);
  const scale = Math.min(bounds.width / viewport.width, bounds.height / viewport.height, 1);
  return <div ref={container} className={`relative overflow-hidden bg-surface-2 ${className}`}>
    <iframe ref={frame} src={src} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" scrolling="no" loading="lazy"
      className="absolute border-0 bg-white" style={{
        width: viewport.width, height: viewport.height, transform: `scale(${scale})`, transformOrigin: "top left",
        left: (bounds.width - viewport.width * scale) / 2, top: (bounds.height - viewport.height * scale) / 2,
      }} />
  </div>;
}
