import Icon from '../common/Icon';
import { cn } from '../../lib/cn';

export default function SidebarNavItem({
  id,
  label,
  icon,
  active,
  disabled = false,
  onNavigate,
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[10px] border-0 px-2.5 py-[11px] text-left text-[11px] transition duration-150 ease-out',
        active
          ? 'bg-[var(--dl-blue)] text-white shadow-[0_5px_13px_rgba(47,115,237,.25)]'
          : 'bg-transparent text-[#d7e2f5] hover:bg-white/[0.08]',
        disabled && 'cursor-default text-[#8298b8] hover:bg-transparent',
      )}
      disabled={disabled}
      onClick={() => !disabled && onNavigate(id)}
      title={disabled ? 'Coming soon' : label}
    >
      <Icon name={icon} size={17} />
      <span>{label}</span>
    </button>
  );
}
