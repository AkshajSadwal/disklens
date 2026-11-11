import Icon from "../common/Icon";

export default function SidebarNavItem({ id, label, icon, active, disabled = false, onNavigate }) {
  return (
    <button
      type="button"
      className={`dl-nav-item${active ? " is-active" : ""}`}
      disabled={disabled}
      onClick={() => !disabled && onNavigate(id)}
      title={disabled ? "Coming soon" : label}
      aria-current={active ? "page" : undefined}
    >
      <Icon name={icon} size={18} />
      <span>{label}</span>
    </button>
  );
}
