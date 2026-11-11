import SidebarNavItem from '../layout/SidebarNavItem';
import StatusIndicator from '../ui/StatusIndicator';

const items = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'storage', label: 'Storage', icon: 'storage' },
  { id: 'programs', label: 'Programs & Cleanup', icon: 'programs' },
  { id: 'ai', label: 'AI Storage Advisor', icon: 'ai' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export default function Sidebar({ active, onNavigate }) {
  return (
    <aside className="sticky top-0 z-50 flex h-screen w-[220px] shrink-0 flex-col bg-gradient-to-b from-[var(--dl-sidebar)] to-[var(--dl-sidebar-2)] px-[14px] py-5 text-white shadow-dl-sidebar">
      <div className="flex items-center gap-2.5 px-2 pb-7 pt-0.5">
        <div className="grid h-[34px] w-[34px] place-items-center rounded-[10px] bg-[#2e7cf6] text-[17px] font-extrabold text-white shadow-[0_6px_18px_rgba(46,124,246,.22)]">
          D
        </div>
        <div>
          <div className="text-[15px] font-extrabold tracking-[-.01em]">DiskLens</div>
          <div className="mt-0.5 text-[9px] text-[#a9bddc]">Storage Intelligence</div>
        </div>
      </div>

      <nav className="grid gap-1.5" aria-label="Primary">
        {items.map((item) => (
          <SidebarNavItem
            key={item.id}
            {...item}
            active={active === item.id}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <StatusIndicator
        title="Local only"
        description="Your index stays on this PC"
      />
    </aside>
  );
}
