import Icon from "./Icon";

const items = [
  { id: "home", label: "Home", icon: "home" },
  { id: "storage", label: "Storage", icon: "storage" },
  { id: "programs", label: "Programs & Cleanup", icon: "programs" },
  { id: "ai", label: "AI Storage Advisor", icon: "ai" },
  { id: "safety", label: "File Safety", icon: "shield", disabled: true },
  { id: "settings", label: "Settings", icon: "settings", disabled: true },
];

export default function Sidebar({ active, onNavigate }) {
  return (
    <aside className="dl-sidebar">
      <div className="dl-brand">
        <div className="dl-brand-mark">A</div>
        <div>
          <div className="dl-brand-name">DiskLens</div>
          <div className="dl-brand-subtitle">Storage intelligence</div>
        </div>
      </div>

      <nav className="dl-nav" aria-label="Primary">
        {items.map((item) => (
          <button
            key={item.id}
            className={`dl-nav-item ${active === item.id ? "is-active" : ""}`}
            disabled={item.disabled}
            onClick={() => !item.disabled && onNavigate(item.id)}
            title={item.disabled ? "Coming soon" : item.label}
          >
            <Icon name={item.icon} size={17} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="dl-sidebar-footer">
        <div className="dl-status-dot" />
        <div>
          <div className="dl-status-title">Local only</div>
          <div className="dl-status-text">Your index stays on this PC</div>
        </div>
      </div>
    </aside>
  );
}
