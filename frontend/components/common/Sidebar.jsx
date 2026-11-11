import SidebarNavItem from "../layout/SidebarNavItem";
import StatusIndicator from "../ui/StatusIndicator";

const items = [
  { id: "home", label: "Home", icon: "home" },
  { id: "storage", label: "Storage", icon: "storage" },
  { id: "programs", label: "Programs & Cleanup", icon: "programs" },
  { id: "ai", label: "AI Storage Advisor", icon: "ai" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export default function Sidebar({ active, onNavigate }) {
  return (
    <aside className="dl-sidebar">
      <div className="dl-brand">
        <div className="dl-brand-mark" aria-hidden="true">D</div>
        <div>
          <div className="dl-brand-name">DiskLens</div>
          <div className="dl-brand-subtitle">Storage Intelligence</div>
        </div>
      </div>

      <nav className="dl-nav" aria-label="Primary">
        {items.map((item) => (
          <SidebarNavItem
            key={item.id}
            {...item}
            active={active === item.id}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <StatusIndicator title="Local only" description="Your index stays on this PC" />
    </aside>
  );
}
