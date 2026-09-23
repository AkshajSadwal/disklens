export default function StatusIndicator({ title, description }) {
  return (
    <div className="mt-auto flex gap-2 rounded-[11px] border border-white/[0.08] bg-white/[0.05] px-2.5 py-[11px] text-white">
      <span
        aria-hidden="true"
        className="mt-1 h-[7px] w-[7px] shrink-0 rounded-full bg-[#29d67d] shadow-[0_0_0_4px_rgba(41,214,125,.12)]"
      />
      <div>
        <div className="text-[9px] font-bold">{title}</div>
        <div className="mt-0.5 text-[8px] leading-[1.35] text-[#a9bdd8]">
          {description}
        </div>
      </div>
    </div>
  );
}
